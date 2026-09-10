/**
 * Shared Upstash REST env resolution.
 *
 * Production has repeatedly shipped trailing newlines on
 * UPSTASH_REDIS_REST_TOKEN (and historically URL / boolean envs) via
 * dashboard copy-paste. The Upstash SDK warns and can fail requests when the
 * token contains whitespace.
 *
 * Policy:
 * - Always trim URL + token at client init.
 * - If trim changes the value, log a one-shot config warning (no secret).
 * - If the raw env is set but empty/invalid after trim, treat as invalid
 *   (fail-fast for rate-limit path; callers decide).
 * - If unset entirely → missing (rate-limit may fall back to in-memory).
 */

import { Redis } from '@upstash/redis';

const URL_ENV = 'UPSTASH_' + 'REDIS_' + 'REST_' + 'URL';
const TOKEN_ENV = 'UPSTASH_' + 'REDIS_' + 'REST_' + 'TOKEN';

export type UpstashResolveResult =
  | {
      status: 'configured';
      url: string;
      token: string;
      /** True when either raw value differed from its trimmed form. */
      trimmed: boolean;
    }
  | { status: 'missing' }
  | {
      status: 'invalid';
      reason: 'empty_after_trim' | 'internal_whitespace' | 'url_not_http';
      trimmed: boolean;
    };

let _warnedTrim = false;
let _warnedInvalid = false;
let _redis: Redis | null = null;
let _redisChecked = false;
let _redisKey: string | null = null;

function rawEnv(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const v = env[name];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Resolve Upstash REST credentials. Never returns secret material beyond the
 * trimmed url/token to the caller that already needs them for Redis init.
 */
export function resolveUpstashConfig(
  env: NodeJS.ProcessEnv = process.env,
): UpstashResolveResult {
  const rawUrl = rawEnv(URL_ENV, env);
  const rawToken = rawEnv(TOKEN_ENV, env);

  if (rawUrl === undefined && rawToken === undefined) {
    return { status: 'missing' };
  }
  // One set, one missing → invalid configuration
  if (rawUrl === undefined || rawToken === undefined) {
    return { status: 'invalid', reason: 'empty_after_trim', trimmed: false };
  }

  const url = rawUrl.trim();
  const token = rawToken.trim();
  const trimmed = url !== rawUrl || token !== rawToken;

  if (!url || !token) {
    return { status: 'invalid', reason: 'empty_after_trim', trimmed };
  }

  // After trim, residual whitespace means the value is still unsafe.
  if (/\s/.test(url) || /\s/.test(token)) {
    return { status: 'invalid', reason: 'internal_whitespace', trimmed };
  }

  if (!/^https?:\/\//i.test(url)) {
    return { status: 'invalid', reason: 'url_not_http', trimmed };
  }

  return { status: 'configured', url, token, trimmed };
}

/** Log once per cold start when trim repaired env whitespace (no secrets). */
export function warnIfUpstashTrimmed(cfg: UpstashResolveResult): void {
  if (cfg.status === 'configured' && cfg.trimmed && !_warnedTrim) {
    _warnedTrim = true;
    console.warn(
      '[sentinel/upstash] UPSTASH_REDIS_REST_URL/TOKEN contained leading/trailing whitespace; trimmed at client init. Re-set the Vercel env without newlines.',
    );
  }
  if (cfg.status === 'invalid' && !_warnedInvalid) {
    _warnedInvalid = true;
    console.error(
      `[sentinel/upstash] UPSTASH_REDIS_REST_* is set but invalid (${cfg.reason}). Rate limit will fail closed when Redis is required.`,
    );
  }
}

/** True when both envs resolve to a usable client config. */
export function isUpstashConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveUpstashConfig(env).status === 'configured';
}

/**
 * Shared Redis client (lazy, process-scoped). Returns null when missing.
 * Throws when env is present but invalid — callers that need fail-closed
 * should catch; shadow sink may catch and degrade.
 */
export function getSharedUpstashRedis(
  env: NodeJS.ProcessEnv = process.env,
): Redis | null {
  const cfg = resolveUpstashConfig(env);
  warnIfUpstashTrimmed(cfg);

  if (cfg.status === 'missing') {
    _redisChecked = true;
    _redis = null;
    _redisKey = null;
    return null;
  }

  if (cfg.status === 'invalid') {
    _redisChecked = true;
    _redis = null;
    _redisKey = null;
    throw new Error(`UPSTASH_REDIS_CONFIG_INVALID:${cfg.reason}`);
  }

  const key = `${cfg.url}\0${cfg.token.length}`;
  if (_redisChecked && _redis && _redisKey === key) {
    return _redis;
  }

  _redis = new Redis({ url: cfg.url, token: cfg.token });
  _redisChecked = true;
  _redisKey = key;
  return _redis;
}

/** Test helper — drop cached client. */
export function _resetSharedUpstashRedis(): void {
  _redis = null;
  _redisChecked = false;
  _redisKey = null;
  _warnedTrim = false;
  _warnedInvalid = false;
}
