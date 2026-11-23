/**
 * Prepared paid-validation transport guard.
 *
 * Running this file exits before any provider call.
 *
 * Prices (USD per million tokens) are the OpenServ catalog at
 * https://docs.openserv.ai/serv-reasoning/models (read 2026-11-23).
 * That table does not list serv-nano or serv-swift.
 *
 * serv-swift: the 2026-11-23 capture reports response model
 * claude-haiku-4-5-20251001. The catalog row for Claude Haiku 4.5
 * (`claude-haiku-4.5`) is $1.25 input and $6.50 output. Billing the
 * alias at that row is inferred, not a documented alias price.
 *
 * serv-nano: the same capture reports response model serv-nano and an
 * OpenAI-shaped usage object. No concrete id is disclosed. The ceiling
 * is the most expensive OpenAI row on that table, GPT 6 Astra
 * (`gpt-6-astra`) at $12 input and $60 output.
 *
 * Before dispatch the guard writes max_completion_tokens and max_tokens
 * onto the JSON body, and refuses the send when the prompt estimate
 * (characters / 4) exceeds the input ceiling. The reservation uses those
 * same ceilings, so the reserved price is the cost of the request that
 * would actually be sent.
 */

import { pathToFileURL } from 'node:url';

export const PAID_RUN_LIMITS = {
  maxAttempts: 180,
  maxUsd: 1.44,
  maxAttemptsPerDraw: 4,
  tokenCeiling: { inputTokens: 8192, outputTokens: 4096 },
};

/** Catalog rates used for the reservation. See the file header. */
export const ALIAS_RATES_USD_PER_MILLION = {
  'serv-swift': { input: 1.25, output: 6.5, basis: 'inferred-haiku-4.5-catalog' },
  'serv-nano': { input: 12, output: 60, basis: 'unproven-ceiling-gpt-6-astra' },
};

export function ratesForAlias(model) {
  return ALIAS_RATES_USD_PER_MILLION[model] ?? ALIAS_RATES_USD_PER_MILLION['serv-nano'];
}

export function maxPricePerCall(model = 'serv-nano', limits = PAID_RUN_LIMITS) {
  const rates = ratesForAlias(model);
  const { inputTokens, outputTokens } = limits.tokenCeiling;
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

/** OpenAI's rough token estimate. Used only to refuse an oversized prompt. */
export function estimatePromptTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  const text = messages.map((message) => {
    if (typeof message?.content === 'string') return message.content;
    return JSON.stringify(message?.content ?? '');
  }).join('\n');
  return Math.ceil(text.length / 4);
}

export class PaidRunCapError extends Error {
  /**
   * @param {'attempts' | 'cost' | 'draw' | 'input'} kind
   */
  constructor(kind) {
    super(`paid-run cap: ${kind}`);
    this.name = 'PaidRunCapError';
    this.kind = kind;
  }
}

/**
 * Cap the JSON chat body. Throws before a send when the prompt estimate
 * exceeds the input ceiling. Output fields are lowered to the ceiling.
 * @param {RequestInit | undefined} init
 */
export function applyRequestCaps(init, limits = PAID_RUN_LIMITS) {
  if (!init || typeof init.body !== 'string') return init;
  let parsed;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (!parsed || typeof parsed !== 'object') return init;
  const promptTokens = estimatePromptTokens(parsed.messages);
  if (promptTokens > limits.tokenCeiling.inputTokens) {
    throw new PaidRunCapError('input');
  }
  const cap = limits.tokenCeiling.outputTokens;
  const requestedCompletion = Number(parsed.max_completion_tokens);
  const requestedMax = Number(parsed.max_tokens);
  parsed.max_completion_tokens = Math.min(
    Number.isFinite(requestedCompletion) ? requestedCompletion : cap,
    cap,
  );
  parsed.max_tokens = Math.min(Number.isFinite(requestedMax) ? requestedMax : cap, cap);
  return { ...init, body: JSON.stringify(parsed) };
}

export function createPaidRunGuard(limits = PAID_RUN_LIMITS) {
  let attempts = 0;
  let booked = 0;
  let drawAttempts = 0;
  return {
    beginDraw() {
      drawAttempts = 0;
    },
    /**
     * Reserve before dispatch. Throws without changing state when the next
     * send would break a cap.
     * @param {string} [model]
     */
    reserve(model = 'serv-nano') {
      const price = maxPricePerCall(model, limits);
      if (attempts + 1 > limits.maxAttempts) throw new PaidRunCapError('attempts');
      if (drawAttempts + 1 > limits.maxAttemptsPerDraw) throw new PaidRunCapError('draw');
      if (booked + price > limits.maxUsd + 1e-9) throw new PaidRunCapError('cost');
      attempts += 1;
      drawAttempts += 1;
      booked += price;
      return { maxPrice: price, model };
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
 * How many of the 50 frozen cases fit under 180 attempts and $1.44 when
 * every nano send is reserved at the unproven Astra ceiling and every
 * swift send at the inferred Haiku 4.5 catalog price.
 */
export function fitFrozenCaseRun({
  cases = 50,
  draws = 1,
  nanoSendsPerDraw = 1,
  swiftSendsPerDraw = 0,
} = {}) {
  const attempts = cases * draws * (nanoSendsPerDraw + swiftSendsPerDraw);
  const usd = cases * draws * (
    nanoSendsPerDraw * maxPricePerCall('serv-nano')
    + swiftSendsPerDraw * maxPricePerCall('serv-swift')
  );
  return {
    attempts,
    usd,
    fits: attempts <= PAID_RUN_LIMITS.maxAttempts && usd <= PAID_RUN_LIMITS.maxUsd + 1e-9,
  };
}

/**
 * @param {typeof fetch} innerFetch
 * @param {typeof PAID_RUN_LIMITS} [limits]
 */
export function installPaidRunFetchGuard(innerFetch, limits = PAID_RUN_LIMITS) {
  const guard = createPaidRunGuard(limits);
  const wrapped = async (input, init) => {
    const capped = applyRequestCaps(init, limits);
    const model = readModel(capped);
    const ticket = guard.reserve(model);
    try {
      const res = await innerFetch(input, capped);
      guard.settle(ticket, measuredUsd(res));
      return res;
    } catch (err) {
      if (err instanceof PaidRunCapError) throw err;
      guard.settleFailure(ticket);
      throw err;
    }
  };
  return { fetch: wrapped, guard };
}

function readModel(init) {
  if (!init || typeof init.body !== 'string') return 'serv-nano';
  try {
    const parsed = JSON.parse(init.body);
    return typeof parsed.model === 'string' ? parsed.model : 'serv-nano';
  } catch {
    return 'serv-nano';
  }
}

function measuredUsd(res) {
  const header = res?.headers?.get?.('x-provider-usd');
  if (header == null || header === '') return null;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * @param {{ draws: { id: string, tries: number, model?: string }[], send: (info: { id: string, attempt: number }) => Promise<{ usd?: number | null }>, limits?: typeof PAID_RUN_LIMITS }} opts
 */
export async function runCappedProviderLoop({ draws, send, limits = PAID_RUN_LIMITS }) {
  const guard = createPaidRunGuard(limits);
  let sends = 0;
  try {
    for (const draw of draws) {
      guard.beginDraw();
      for (let attempt = 0; attempt < draw.tries; attempt++) {
        const ticket = guard.reserve(draw.model ?? 'serv-nano');
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
