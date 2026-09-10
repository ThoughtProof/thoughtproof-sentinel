/**
 * Single source for Sentinel rate-limit numbers (issue #43).
 *
 * Literal exports — do **not** `import` the sibling JSON from serverless
 * handlers. Vercel Node does not apply Vitest's JSON-import transform, so
 * `import policy from './rate-limit-policy.json'` crashes the function at
 * load time (Preview `/sentinel/health` → FUNCTION_INVOCATION_FAILED).
 *
 * `scripts/rate-limit-burst-check.mjs` reads `rate-limit-policy.json` via
 * fs. `src/rate-limit-policy.test.ts` asserts the two stay in lockstep.
 */

export const AUTHENTICATED_RATE_LIMIT_PER_MINUTE = 120;
export const GLOBAL_RATE_LIMIT_PER_MINUTE_DEFAULT = 30;
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMIT_WINDOW = `${RATE_LIMIT_WINDOW_SECONDS} s` as const;
export const RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_S = 30;
/** Burst script default — must sit above AUTHENTICATED_RATE_LIMIT_PER_MINUTE. */
export const BURST_CHECK_DEFAULT_N = 140;

export type RateLimitBackend = 'redis' | 'in_memory' | 'unavailable';
