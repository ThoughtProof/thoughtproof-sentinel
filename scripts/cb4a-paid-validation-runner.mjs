/**
 * Prepared paid-validation runner for the trade_execution nano contract.
 *
 * This file does not send. Running it exits before any provider call.
 * The caps are what a future run must enforce:
 *   - 180 provider sends, counting every retry and fallback
 *   - $1.44 measured cost, or the priced fallback when the provider omits cost
 *   - 4 sends per draw, so pot-cli's parse retries cannot reach 7
 * Either hard limit aborts before the next send.
 *
 * Offline tests import `runCappedProviderLoop` with a mocked send.
 */

export const PAID_RUN_LIMITS = {
  maxAttempts: 180,
  maxUsd: 1.44,
  maxAttemptsPerDraw: 4,
  /** 180 * 0.008 = 1.44. Used when a response has no measured cost. */
  pricedUsdPerCall: 0.008,
};

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
  let usd = 0;
  let drawAttempts = 0;
  return {
    beginDraw() {
      drawAttempts = 0;
    },
    /** Throws before the send when a cap is already exhausted. */
    beforeSend() {
      if (attempts >= limits.maxAttempts) throw new PaidRunCapError('attempts');
      if (usd >= limits.maxUsd - 1e-9) throw new PaidRunCapError('cost');
      if (drawAttempts >= limits.maxAttemptsPerDraw) throw new PaidRunCapError('draw');
    },
    /**
     * @param {number | null | undefined} measuredUsd
     */
    afterSend(measuredUsd) {
      attempts += 1;
      drawAttempts += 1;
      const price = typeof measuredUsd === 'number' && Number.isFinite(measuredUsd) && measuredUsd >= 0
        ? measuredUsd
        : limits.pricedUsdPerCall;
      usd += price;
    },
    snapshot() {
      return { attempts, usd, drawAttempts };
    },
  };
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
        guard.beforeSend();
        const res = await send({ id: draw.id, attempt });
        sends += 1;
        guard.afterSend(res?.usd);
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

import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error('cb4a paid validation is prepared only. No provider send was made.');
  process.exit(2);
}
