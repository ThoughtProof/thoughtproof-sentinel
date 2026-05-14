/**
 * Sentinel Auth & Rate Limiting
 *
 * Phase 0: Open (no auth)
 * Phase 1: X-Sentinel-Key validation + per-key rate limiting
 *
 * Rate limiting uses Upstash Redis when UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN are set. Falls back to in-memory (per-invocation)
 * when not configured — this only works within a single warm Vercel instance.
 *
 * This module is a platform adapter concern — NOT part of the engine.
 */

import type { PaymentPlatform } from './types.js';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// --- API Key Store ---
// Phase 1: Move to Vercel KV or Supabase. For now, env-var based.

interface ApiKeyConfig {
  key: string;
  platform: PaymentPlatform;
  agent_id?: string;
  rate_limit_per_minute: number;
  enabled: boolean;
}

// --- Upstash Rate Limiters (lazy init) ---

let _authenticatedLimiter: Ratelimit | null = null;
let _globalLimiter: Ratelimit | null = null;
let _upstashChecked = false;

function getUpstashLimiters(): { authenticated: Ratelimit; global: Ratelimit } | null {
  if (_upstashChecked) {
    return _authenticatedLimiter && _globalLimiter
      ? { authenticated: _authenticatedLimiter, global: _globalLimiter }
      : null;
  }
  _upstashChecked = true;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return null;
  }

  const redis = new Redis({ url, token });

  _authenticatedLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(120, '60 s'),
    prefix: 'sentinel:rl:auth',
  });

  _globalLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(
      parseInt(process.env.SENTINEL_GLOBAL_RATE_LIMIT ?? '30', 10),
      '60 s',
    ),
    prefix: 'sentinel:rl:global',
  });

  return { authenticated: _authenticatedLimiter, global: _globalLimiter };
}

/** Reset cached limiters — for testing only */
export function _resetLimiters(): void {
  _authenticatedLimiter = null;
  _globalLimiter = null;
  _upstashChecked = false;
}

// --- In-memory fallback (original) ---

const rateLimitWindows = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimitInMemory(
  key: string,
  maxPerMinute: number,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const existing = rateLimitWindows.get(key);

  if (!existing || (now - existing.windowStart) > RATE_LIMIT_WINDOW_MS) {
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
 * Falls back to in-memory per-invocation tracking otherwise.
 */
export async function checkRateLimit(
  key: string,
  maxPerMinute: number = 60,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const upstash = getUpstashLimiters();

  if (upstash) {
    const result = await upstash.authenticated.limit(key);
    return {
      allowed: result.success,
      remaining: result.remaining,
      resetAt: result.reset,
    };
  }

  // Fallback: in-memory (only protects within a single warm instance)
  return checkRateLimitInMemory(key, maxPerMinute);
}

/**
 * Global rate limit for unauthenticated requests (Phase 0).
 * More restrictive than per-key limits.
 */
export async function checkGlobalRateLimit(): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const upstash = getUpstashLimiters();

  if (upstash) {
    const result = await upstash.global.limit('__global__');
    return {
      allowed: result.success,
      remaining: result.remaining,
      resetAt: result.reset,
    };
  }

  // Fallback
  const globalMax = parseInt(process.env.SENTINEL_GLOBAL_RATE_LIMIT ?? '30', 10);
  return checkRateLimitInMemory('__global__', globalMax);
}
