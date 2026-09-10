/**
 * Single source for Sentinel rate-limit numbers (issue #43).
 *
 * `checkRateLimit(key, n)` used to ignore `n` on the Upstash path
 * (`slidingWindow(120, '60 s')` hardcoded). Callers, the limiter,
 * OpenAPI, ADR-0021, and `scripts/rate-limit-burst-check.mjs` all
 * read these values so the authenticated ceiling cannot drift.
 */

import policy from './rate-limit-policy.json';

export const AUTHENTICATED_RATE_LIMIT_PER_MINUTE = policy.authenticatedPerMinute;
export const GLOBAL_RATE_LIMIT_PER_MINUTE_DEFAULT = policy.globalPerMinuteDefault;
export const RATE_LIMIT_WINDOW_SECONDS = policy.windowSeconds;
export const RATE_LIMIT_WINDOW = `${policy.windowSeconds} s` as const;
export const RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_S = policy.unavailableRetryAfterS;
/** Burst script default — must sit above AUTHENTICATED_RATE_LIMIT_PER_MINUTE. */
export const BURST_CHECK_DEFAULT_N = policy.burstCheckDefaultN;

export type RateLimitBackend = 'redis' | 'in_memory' | 'unavailable';
