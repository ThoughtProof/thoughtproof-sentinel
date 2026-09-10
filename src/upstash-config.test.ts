import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveUpstashConfig,
  isUpstashConfigured,
  getSharedUpstashRedis,
  _resetSharedUpstashRedis,
  warnIfUpstashTrimmed,
} from './upstash-config.js';

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation((opts: { url: string; token: string }) => ({
    __opts: opts,
  })),
}));

describe('resolveUpstashConfig', () => {
  it('returns missing when both unset', () => {
    expect(resolveUpstashConfig({})).toEqual({ status: 'missing' });
  });

  it('trims trailing newline on token', () => {
    const cfg = resolveUpstashConfig({
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'abc123\n',
    });
    expect(cfg.status).toBe('configured');
    if (cfg.status === 'configured') {
      expect(cfg.token).toBe('abc123');
      expect(cfg.trimmed).toBe(true);
      expect(cfg.url).toBe('https://example.upstash.io');
    }
  });

  it('trims leading/trailing spaces on URL', () => {
    const cfg = resolveUpstashConfig({
      UPSTASH_REDIS_REST_URL: '  https://example.upstash.io  ',
      UPSTASH_REDIS_REST_TOKEN: 'tok',
    });
    expect(cfg.status).toBe('configured');
    if (cfg.status === 'configured') {
      expect(cfg.url).toBe('https://example.upstash.io');
      expect(cfg.trimmed).toBe(true);
    }
  });

  it('rejects empty after trim', () => {
    const cfg = resolveUpstashConfig({
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: '   \n',
    });
    expect(cfg).toEqual({
      status: 'invalid',
      reason: 'empty_after_trim',
      trimmed: true,
    });
  });

  it('rejects internal whitespace that trim cannot fix', () => {
    const cfg = resolveUpstashConfig({
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'ab cd',
    });
    expect(cfg.status).toBe('invalid');
    if (cfg.status === 'invalid') {
      expect(cfg.reason).toBe('internal_whitespace');
    }
  });

  it('rejects non-http URL', () => {
    const cfg = resolveUpstashConfig({
      UPSTASH_REDIS_REST_URL: 'redis://example',
      UPSTASH_REDIS_REST_TOKEN: 'tok',
    });
    expect(cfg.status).toBe('invalid');
    if (cfg.status === 'invalid') {
      expect(cfg.reason).toBe('url_not_http');
    }
  });

  it('rejects half-configured env', () => {
    expect(
      resolveUpstashConfig({
        UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      }).status,
    ).toBe('invalid');
  });
});

describe('getSharedUpstashRedis', () => {
  beforeEach(() => {
    _resetSharedUpstashRedis();
  });

  afterEach(() => {
    _resetSharedUpstashRedis();
  });

  it('returns null when missing', () => {
    expect(getSharedUpstashRedis({})).toBeNull();
  });

  it('returns client with trimmed credentials', () => {
    const redis = getSharedUpstashRedis({
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io\n',
      UPSTASH_REDIS_REST_TOKEN: 'tok\n',
    }) as { __opts: { url: string; token: string } } | null;
    expect(redis).not.toBeNull();
    expect(redis!.__opts.url).toBe('https://example.upstash.io');
    expect(redis!.__opts.token).toBe('tok');
  });

  it('throws on invalid config', () => {
    expect(() =>
      getSharedUpstashRedis({
        UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'ab cd',
      }),
    ).toThrow(/UPSTASH_REDIS_CONFIG_INVALID/);
  });

  it('isUpstashConfigured false for invalid', () => {
    expect(
      isUpstashConfigured({
        UPSTASH_REDIS_REST_URL: 'https://x',
        UPSTASH_REDIS_REST_TOKEN: ' ',
      }),
    ).toBe(false);
  });

  it('warnIfUpstashTrimmed logs once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = resolveUpstashConfig({
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'tok\n',
    });
    warnIfUpstashTrimmed(cfg);
    warnIfUpstashTrimmed(cfg);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
