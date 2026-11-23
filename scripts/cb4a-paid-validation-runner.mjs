/**
 * Prepared paid-validation transport guard.
 *
 * Running this file exits before any provider call. The guard wraps fetch:
 * before dispatch it reserves one attempt and a worst-case price from the
 * token ceiling times the provider price table. A send is refused when
 * attempts + 1 would pass 180, or booked + reserved + maxPrice would pass
 * $1.44. A dispatch that throws keeps the reservation at the max price.
 * Measured cost, when present, reconciles the reservation down.
 */

import { pathToFileURL } from 'node:url';

export const PAID_RUN_LIMITS = {
  maxAttempts: 180,
  maxUsd: 1.44,
  maxAttemptsPerDraw: 4,
  tokenCeiling: { inputTokens: 8192, outputTokens: 4096 },
  /**
   * Ceiling rates, USD per million tokens. serv-nano and serv-swift returned
   * no dollar price. 8192 * $50 + 4096 * $100 per million is $0.8192, so a
   * second call cannot be dispatched once $0.80 is booked against $1.44.
   */
  usdPerMillionTokens: { input: 50, output: 100 },
};

export function maxPricePerCall(limits = PAID_RUN_LIMITS) {
  const { inputTokens, outputTokens } = limits.tokenCeiling;
  const { input, output } = limits.usdPerMillionTokens;
  return (inputTokens * input + outputTokens * output) / 1_000_000;
}

export class PaidRunCapError extends Error {
  /**
   * @param {'attempts' | 'cost' | 'draw'} kind
   */
  constructor(kind) {
    super(`paid-run cap: ${kind}`);
    this.name = 'PaidRunCapError';
    this.kind = kind;
  }
}

export function createPaidRunGuard(limits = PAID_RUN_LIMITS) {
  let attempts = 0;
  let booked = 0;
  let drawAttempts = 0;
  const maxPrice = () => maxPricePerCall(limits);
  return {
    beginDraw() {
      drawAttempts = 0;
    },
    /**
     * Reserve before dispatch. Throws without changing state when the next
     * send would break a cap. On success the attempt and the max price are
     * already booked.
     */
    reserve() {
      const price = maxPrice();
      if (attempts + 1 > limits.maxAttempts) throw new PaidRunCapError('attempts');
      if (drawAttempts + 1 > limits.maxAttemptsPerDraw) throw new PaidRunCapError('draw');
      if (booked + price > limits.maxUsd + 1e-9) throw new PaidRunCapError('cost');
      attempts += 1;
      drawAttempts += 1;
      booked += price;
      return { maxPrice: price };
    },
    /**
     * @param {{ maxPrice: number }} ticket
     * @param {number | null | undefined} measuredUsd
     */
    settle(ticket, measuredUsd) {
      if (typeof measuredUsd === 'number' && Number.isFinite(measuredUsd) && measuredUsd >= 0) {
        booked += measuredUsd - ticket.maxPrice;
      }
    },
    /** Timeout, abort, or throw after dispatch. Reservation stays at max price. */
    settleFailure(_ticket) {},
    snapshot() {
      return { attempts, usd: booked, booked, drawAttempts };
    },
  };
}

/**
 * @param {typeof fetch} innerFetch
 * @param {typeof PAID_RUN_LIMITS} [limits]
 */
export function installPaidRunFetchGuard(innerFetch, limits = PAID_RUN_LIMITS) {
  const guard = createPaidRunGuard(limits);
  const wrapped = async (input, init) => {
    const ticket = guard.reserve();
    try {
      const res = await innerFetch(input, init);
      guard.settle(ticket, measuredUsd(res));
      return res;
    } catch (err) {
      guard.settleFailure(ticket);
      throw err;
    }
  };
  return { fetch: wrapped, guard };
}

function measuredUsd(res) {
  const header = res?.headers?.get?.('x-provider-usd');
  if (header == null || header === '') return null;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * @param {{ draws: { id: string, tries: number }[], send: (info: { id: string, attempt: number }) => Promise<{ usd?: number | null }>, limits?: typeof PAID_RUN_LIMITS }} opts
 */
export async function runCappedProviderLoop({ draws, send, limits = PAID_RUN_LIMITS }) {
  const guard = createPaidRunGuard(limits);
  let sends = 0;
  try {
    for (const draw of draws) {
      guard.beginDraw();
      for (let attempt = 0; attempt < draw.tries; attempt++) {
        const ticket = guard.reserve();
        try {
          const res = await send({ id: draw.id, attempt });
          sends += 1;
          guard.settle(ticket, res?.usd);
        } catch (err) {
          if (err instanceof PaidRunCapError) throw err;
          sends += 1;
          guard.settleFailure(ticket);
          throw err;
        }
      }
    }
    return { stopped: null, sends, ...guard.snapshot() };
  } catch (err) {
    if (err instanceof PaidRunCapError) {
      return { stopped: err.kind, sends, ...guard.snapshot() };
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error('cb4a paid validation is prepared only. No provider send was made.');
  process.exit(2);
}
