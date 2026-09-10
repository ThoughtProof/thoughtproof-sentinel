import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_RATE_LIMIT_PER_MINUTE,
  BURST_CHECK_DEFAULT_N,
  GLOBAL_RATE_LIMIT_PER_MINUTE_DEFAULT,
  RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_S,
  RATE_LIMIT_WINDOW,
} from './rate-limit-policy.js';
import policy from './rate-limit-policy.json';

describe('rate-limit-policy single source', () => {
  it('exports the JSON ceiling used by limiter, callers, and burst script', () => {
    expect(AUTHENTICATED_RATE_LIMIT_PER_MINUTE).toBe(policy.authenticatedPerMinute);
    expect(AUTHENTICATED_RATE_LIMIT_PER_MINUTE).toBe(120);
    expect(GLOBAL_RATE_LIMIT_PER_MINUTE_DEFAULT).toBe(30);
    expect(RATE_LIMIT_WINDOW).toBe('60 s');
    expect(RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_S).toBe(30);
  });

  it('burst default sits above the authenticated ceiling', () => {
    expect(BURST_CHECK_DEFAULT_N).toBeGreaterThan(AUTHENTICATED_RATE_LIMIT_PER_MINUTE);
    expect(BURST_CHECK_DEFAULT_N).toBe(140);
  });
});
