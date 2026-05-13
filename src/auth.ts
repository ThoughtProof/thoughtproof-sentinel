/**
 * Sentinel Auth & Rate Limiting
 *
 * Phase 0: Open (no auth)
 * Phase 1: X-Sentinel-Key validation + per-key rate limiting
 *
 * This module is a platform adapter concern — NOT part of the engine.
 */

import type { PaymentPlatform } from './types.js';

// --- API Key Store ---
// Phase 1: Move to Vercel KV or Supabase. For now, env-var based.

interface ApiKeyConfig {
  key: string;
  platform: PaymentPlatform;
  agent_id?: string;
  rate_limit_per_minute: number;
  enabled: boolean;
}

// In-memory rate limit tracking (per Vercel invocation = no cross-invocation state)
// For production: use Vercel KV or Upstash Redis
const rateLimitWindows = new Map<string, { count: number; windowStart: number }>();

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

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
    // Phase 0: open access
    return { valid: true };
  }

  if (!headerValue) {
    return { valid: false, error: 'Missing X-Sentinel-Key header' };
  }

  // Phase 1: check against env-stored keys
  // Format: SENTINEL_API_KEYS="sk_sentinel_abc123:openserv:agent42,sk_sentinel_def456:acp:0xABC"
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
 * Note: In Vercel Serverless, each invocation is isolated — this only protects
 * against burst within a single warm function instance. For real rate limiting,
 * use Upstash Redis (@upstash/ratelimit).
 *
 * For Phase 0 (AMA demo), this provides basic burst protection.
 */
export function checkRateLimit(
  key: string,
  maxPerMinute: number = 60,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const existing = rateLimitWindows.get(key);

  if (!existing || (now - existing.windowStart) > RATE_LIMIT_WINDOW_MS) {
    // New window
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

/**
 * Global rate limit for unauthenticated requests (Phase 0).
 * More restrictive than per-key limits.
 */
export function checkGlobalRateLimit(): { allowed: boolean; remaining: number } {
  const globalMax = parseInt(process.env.SENTINEL_GLOBAL_RATE_LIMIT ?? '30', 10); // 30/min default
  return checkRateLimit('__global__', globalMax);
}
