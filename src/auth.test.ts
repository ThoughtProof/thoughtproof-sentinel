/**
 * Tests for Auth & Rate Limiting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateApiKey, checkRateLimit, checkGlobalRateLimit } from './auth.js';

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
    process.env.SENTINEL_API_KEYS = 'sk_sentinel_real:openserv:agent1';
    const result = validateApiKey('sk_sentinel_fake');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid');
  });

  it('accepts valid key and returns platform info', () => {
    process.env.SENTINEL_AUTH_REQUIRED = 'true';
    process.env.SENTINEL_API_KEYS = 'sk_sentinel_abc:openserv:agent42,sk_sentinel_def:acp:0xABC';
    const result = validateApiKey('sk_sentinel_abc');
    expect(result.valid).toBe(true);
    expect(result.platform).toBe('openserv');
    expect(result.agent_id).toBe('agent42');
  });

  it('handles multiple keys', () => {
    process.env.SENTINEL_AUTH_REQUIRED = 'true';
    process.env.SENTINEL_API_KEYS = 'sk_sentinel_abc:openserv:agent42,sk_sentinel_def:acp:0xABC';
    const result = validateApiKey('sk_sentinel_def');
    expect(result.valid).toBe(true);
    expect(result.platform).toBe('acp');
    expect(result.agent_id).toBe('0xABC');
  });
});

describe('checkRateLimit', () => {
  it('allows first request', () => {
    const result = checkRateLimit('test_key_1', 10);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it('blocks after exceeding limit', () => {
    const key = 'test_key_burst';
    for (let i = 0; i < 5; i++) {
      checkRateLimit(key, 5);
    }
    const result = checkRateLimit(key, 5);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('tracks remaining correctly', () => {
    const key = 'test_key_remaining';
    checkRateLimit(key, 10);
    checkRateLimit(key, 10);
    const result = checkRateLimit(key, 10);
    expect(result.remaining).toBe(7);
  });
});

describe('checkGlobalRateLimit', () => {
  it('uses default limit of 30/min', () => {
    const result = checkGlobalRateLimit();
    expect(result.allowed).toBe(true);
  });
});
