/**
 * Sentinel Auth & Rate Limiting
 *
 * Phase 0: Open (no auth)
 * Phase 1: X-Sentinel-Key validation + per-key rate limiting
 *
 * Rate limiting uses Upstash Redis when UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN resolve cleanly. Falls back to in-memory
 * (per-invocation) only when Redis is **unset** — not when it is broken.
 *
 * When Redis is configured but unavailable / errors at limit-time:
 * **fail closed** (see docs/ADR-0021-rate-limit-fail-closed.md). Callers map
 * `unavailable: true` to HTTP 503 RATE_LIMIT_UNAVAILABLE before x402.
 *
 * This module is a platform adapter concern — NOT part of the engine.
 */

import type { PaymentPlatform } from './types.js';
import { Ratelimit } from '@upstash/ratelimit';
import {
  getSharedUpstashRedis,
  resolveUpstashConfig,
  warnIfUpstashTrimmed,
  _resetSharedUpstashRedis,
} from './upstash-config.js';
import {
  AUTHENTICATED_RATE_LIMIT_PER_MINUTE,
  GLOBAL_RATE_LIMIT_PER_MINUTE_DEFAULT,
  RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_S,
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_WINDOW_SECONDS,
  type RateLimitBackend,
} from './rate-limit-policy.js';

export {
  AUTHENTICATED_RATE_LIMIT_PER_MINUTE,
  GLOBAL_RATE_LIMIT_PER_MINUTE_DEFAULT,
  RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_S,
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_WINDOW_SECONDS,
  type RateLimitBackend,
} from './rate-limit-policy.js';

// --- API Key Store ---
// Phase 1: Move to Vercel KV or Supabase. For now, env-var based.

interface ApiKeyConfig {
  key: string;
  platform: PaymentPlatform;
  agent_id?: string;
  rate_limit_per_minute: number;
  enabled: boolean;
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  /** True when Redis was required but could not answer — fail closed. */
  unavailable?: boolean;
  code?: 'RATE_LIMIT_UNAVAILABLE';
};

// --- Upstash Rate Limiters (lazy init) ---

let _authenticatedLimiter: Ratelimit | null = null;
let _globalLimiter: Ratelimit | null = null;
let _upstashChecked = false;
/** 'ready' | 'missing' | 'invalid' | 'error' */
let _upstashState: 'ready' | 'missing' | 'invalid' | 'error' = 'missing';

function getUpstashLimiters():
  | { ok: true; authenticated: Ratelimit; global: Ratelimit }
  | { ok: false; state: 'missing' | 'invalid' | 'error' } {
  if (_upstashChecked) {
    if (_upstashState === 'ready' && _authenticatedLimiter && _globalLimiter) {
      return {
        ok: true,
        authenticated: _authenticatedLimiter,
        global: _globalLimiter,
      };
    }
    return { ok: false, state: _upstashState === 'ready' ? 'error' : _upstashState };
  }
  _upstashChecked = true;

  const cfg = resolveUpstashConfig();
  warnIfUpstashTrimmed(cfg);

  if (cfg.status === 'missing') {
    _upstashState = 'missing';
    return { ok: false, state: 'missing' };
  }

  if (cfg.status === 'invalid') {
    _upstashState = 'invalid';
    return { ok: false, state: 'invalid' };
  }

  try {
    const redis = getSharedUpstashRedis();
    if (!redis) {
      _upstashState = 'missing';
      return { ok: false, state: 'missing' };
    }

    _authenticatedLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(AUTHENTICATED_RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW),
      prefix: 'sentinel:rl:auth',
    });

    _globalLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(resolveGlobalRateLimitPerMinute(), RATE_LIMIT_WINDOW),
      prefix: 'sentinel:rl:global',
    });

    _upstashState = 'ready';
    return {
      ok: true,
      authenticated: _authenticatedLimiter,
      global: _globalLimiter,
    };
  } catch (err) {
    _upstashState = 'error';
    console.error(
      '[sentinel/auth] Upstash limiter init failed:',
      err instanceof Error ? err.message : err,
    );
    return { ok: false, state: 'error' };
  }
}

function resolveGlobalRateLimitPerMinute(): number {
  const parsed = parseInt(
    process.env.SENTINEL_GLOBAL_RATE_LIMIT ?? String(GLOBAL_RATE_LIMIT_PER_MINUTE_DEFAULT),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : GLOBAL_RATE_LIMIT_PER_MINUTE_DEFAULT;
}

function unavailableResult(): RateLimitResult {
  return {
    allowed: false,
    remaining: 0,
    resetAt: Date.now() + RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_S * 1000,
    unavailable: true,
    code: 'RATE_LIMIT_UNAVAILABLE',
  };
}

/**
 * Rate-limit store readiness for `/sentinel/health` (issue #43).
 * Config probe only — no Redis I/O. After limiters have been initialized
 * in this process, reports the cached limiter state (including init error).
 */
export function getRateLimitReadiness(
  env: NodeJS.ProcessEnv = process.env,
): { rate_limit: RateLimitBackend } {
  if (env === process.env && _upstashChecked) {
    if (_upstashState === 'ready') return { rate_limit: 'redis' };
    if (_upstashState === 'missing') return { rate_limit: 'in_memory' };
    return { rate_limit: 'unavailable' };
  }

  const cfg = resolveUpstashConfig(env);
  if (cfg.status === 'configured') return { rate_limit: 'redis' };
  if (cfg.status === 'missing') return { rate_limit: 'in_memory' };
  return { rate_limit: 'unavailable' };
}

/** Reset cached limiters — for testing only */
export function _resetLimiters(): void {
  _authenticatedLimiter = null;
  _globalLimiter = null;
  _upstashChecked = false;
  _upstashState = 'missing';
  _resetSharedUpstashRedis();
}

// --- In-memory fallback (original) ---

const rateLimitWindows = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_SECONDS * 1000;

function checkRateLimitInMemory(
  key: string,
  maxPerMinute: number,
): RateLimitResult {
  const now = Date.now();
  const existing = rateLimitWindows.get(key);

  if (!existing || now - existing.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitWindows.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: maxPerMinute - 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }

  existing.count++;

  if (existing.count > maxPerMinute) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: existing.windowStart + RATE_LIMIT_WINDOW_MS,
    };
  }

  return {
    allowed: true,
    remaining: maxPerMinute - existing.count,
    resetAt: existing.windowStart + RATE_LIMIT_WINDOW_MS,
  };
}

// --- Public API ---

/**
 * Validate an API key from X-Sentinel-Key header.
 *
 * Phase 0: If SENTINEL_AUTH_REQUIRED is not set or "false", all requests pass.
 * Phase 1: Validates against SENTINEL_API_KEYS (comma-separated in env).
 */
export function validateApiKey(
  headerValue: string | undefined,
): { valid: boolean; error?: string; platform?: PaymentPlatform; agent_id?: string } {
  const authRequired = process.env.SENTINEL_AUTH_REQUIRED === 'true';

  if (!authRequired) {
    return { valid: true };
  }

  if (!headerValue) {
    return { valid: false, error: 'Missing X-Sentinel-Key header' };
  }

  const keysRaw = process.env.SENTINEL_API_KEYS ?? '';
  const keyConfigs = keysRaw.split(',').filter(Boolean).map((entry) => {
    const [key, platform, agent_id] = entry.trim().split(':');
    return { key, platform: (platform as PaymentPlatform) ?? 'direct', agent_id };
  });

  const matched = keyConfigs.find((k) => k.key === headerValue);
  if (!matched) {
    return { valid: false, error: 'Invalid API key' };
  }

  return {
    valid: true,
    platform: matched.platform,
    agent_id: matched.agent_id,
  };
}

/**
 * Check rate limit for a given key.
 *
 * Uses Upstash Redis sliding window when configured.
 * Falls back to in-memory only when Redis env is unset.
 * Fail-closed (unavailable) when Redis is configured but broken/errors.
 */
export async function checkRateLimit(
  key: string,
  maxPerMinute: number = AUTHENTICATED_RATE_LIMIT_PER_MINUTE,
): Promise<RateLimitResult> {
  const upstash = getUpstashLimiters();

  if (!upstash.ok) {
    if (upstash.state === 'missing') {
      return checkRateLimitInMemory(key, maxPerMinute);
    }
    // invalid | error → fail closed (do not silently uncap paid traffic)
    return unavailableResult();
  }

  try {
    const result = await upstash.authenticated.limit(key);
    return {
      allowed: result.success,
      remaining: result.remaining,
      resetAt: result.reset,
    };
  } catch (err) {
    console.error(
      '[sentinel/auth] Upstash rate-limit call failed (fail-closed):',
      err instanceof Error ? err.message : err,
    );
    return unavailableResult();
  }
}

/**
 * Global rate limit for unauthenticated requests (Phase 0).
 * More restrictive than per-key limits.
 */
export async function checkGlobalRateLimit(): Promise<RateLimitResult> {
  const upstash = getUpstashLimiters();

  if (!upstash.ok) {
    if (upstash.state === 'missing') {
      return checkRateLimitInMemory('__global__', resolveGlobalRateLimitPerMinute());
    }
    return unavailableResult();
  }

  try {
    const result = await upstash.global.limit('__global__');
    return {
      allowed: result.success,
      remaining: result.remaining,
      resetAt: result.reset,
    };
  } catch (err) {
    console.error(
      '[sentinel/auth] Upstash global rate-limit call failed (fail-closed):',
      err instanceof Error ? err.message : err,
    );
    return unavailableResult();
  }
}

/** Stable payload for HTTP 503 when the limiter cannot answer. */
export function rateLimitUnavailablePayload(requestId: string): {
  error: string;
  code: 'RATE_LIMIT_UNAVAILABLE';
  request_id: string;
  retry_after_s: number;
} {
  return {
    error: 'Rate limit service temporarily unavailable',
    code: 'RATE_LIMIT_UNAVAILABLE',
    request_id: requestId,
    retry_after_s: RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_S,
  };
}
