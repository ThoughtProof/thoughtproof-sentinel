/**
 * Tests for Auth & Rate Limiting
 *
 * Tests both Upstash Redis path and in-memory fallback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateApiKey, checkRateLimit, checkGlobalRateLimit, _resetLimiters } from './auth.js';

// Mock @upstash/ratelimit
vi.mock('@upstash/ratelimit', () => {
  const mockLimit = vi.fn().mockResolvedValue({
    success: true,
    remaining: 119,
    reset: Date.now() + 60000,
    limit: 120,
  });

  const RatelimitMock = vi.fn().mockImplementation(() => ({
    limit: mockLimit,
  }));

  // Static method used in: new Ratelimit({ limiter: Ratelimit.slidingWindow(...) })
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue('sliding-window-config');

  return {
    Ratelimit: RatelimitMock,
  };
});

// Mock @upstash/redis
vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({})),
}));

describe('validateApiKey', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('allows all requests when SENTINEL_AUTH_REQUIRED is not set', () => {
    delete process.env.SENTINEL_AUTH_REQUIRED;
    const result = validateApiKey(undefined);
    expect(result.valid).toBe(true);
  });

  it('allows all requests when SENTINEL_AUTH_REQUIRED is false', () => {
    process.env.SENTINEL_AUTH_REQUIRED = 'false';
    const result = validateApiKey(undefined);
    expect(result.valid).toBe(true);
  });

  it('rejects missing header when auth is required', () => {
    process.env.SENTINEL_AUTH_REQUIRED = 'true';
    const result = validateApiKey(undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing');
  });

  it('rejects invalid key when auth is required', () => {
    process.env.SENTINEL_AUTH_REQUIRED = 'true';
    process.env.SENTINEL_API_KEYS = 'sk_valid_key:openserv:agent1';
    const result = validateApiKey('sk_wrong_key');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid');
  });

  it('accepts valid key and returns platform info', () => {
    process.env.SENTINEL_AUTH_REQUIRED = 'true';
    process.env.SENTINEL_API_KEYS = 'sk_key_one:openserv:agent42,sk_key_two:acp:0xABC';
    const result = validateApiKey('sk_key_one');
    expect(result.valid).toBe(true);
    expect(result.platform).toBe('openserv');
    expect(result.agent_id).toBe('agent42');
  });

  it('handles multiple keys', () => {
    process.env.SENTINEL_AUTH_REQUIRED = 'true';
    process.env.SENTINEL_API_KEYS = 'sk_key_one:openserv:agent42,sk_key_two:acp:0xABC';
    const result = validateApiKey('sk_key_two');
    expect(result.valid).toBe(true);
    expect(result.platform).toBe('acp');
    expect(result.agent_id).toBe('0xABC');
  });
});

describe('checkRateLimit — in-memory fallback', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Ensure no Upstash env vars → forces in-memory fallback
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    _resetLimiters();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetLimiters();
  });

  it('allows first request', async () => {
    const result = await checkRateLimit('test_inmem_1', 10);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it('blocks after exceeding limit', async () => {
    const key = 'test_inmem_burst';
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(key, 5);
    }
    const result = await checkRateLimit(key, 5);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('tracks remaining correctly', async () => {
    const key = 'test_inmem_remaining';
    await checkRateLimit(key, 10);
    await checkRateLimit(key, 10);
    const result = await checkRateLimit(key, 10);
    expect(result.remaining).toBe(7);
  });
});

describe('checkRateLimit — Upstash Redis', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    _resetLimiters();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetLimiters();
  });

  it('uses Upstash when configured', async () => {
    const result = await checkRateLimit('test_upstash_key', 120);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(119);
  });

  it('returns Upstash reset timestamp', async () => {
    const result = await checkRateLimit('test_upstash_reset', 120);
    expect(result.resetAt).toBeGreaterThan(Date.now() - 1000);
  });
});

describe('checkGlobalRateLimit — in-memory fallback', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    _resetLimiters();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetLimiters();
  });

  it('uses default limit of 30/min', async () => {
    const result = await checkGlobalRateLimit();
    expect(result.allowed).toBe(true);
  });
});

describe('checkGlobalRateLimit — Upstash Redis', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    _resetLimiters();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetLimiters();
  });

  it('uses Upstash global limiter when configured', async () => {
    const result = await checkGlobalRateLimit();
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(119);
  });
});
