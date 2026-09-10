/**
 * Shared Upstash REST client.
 *
 * Env resolution lives in `upstash-env.ts` (no Redis import) so
 * `/sentinel/health` can report `rate_limit` without loading the SDK.
 */

import { Redis } from '@upstash/redis';
import {
  resolveUpstashConfig,
  warnIfUpstashTrimmed,
  _resetUpstashEnvWarnings,
} from './upstash-env.js';

export {
  resolveUpstashConfig,
  warnIfUpstashTrimmed,
  isUpstashConfigured,
  getRateLimitReadiness,
  _resetUpstashEnvWarnings,
  type UpstashResolveResult,
  type RateLimitBackend,
} from './upstash-env.js';

let _redis: Redis | null = null;
let _redisChecked = false;
let _redisKey: string | null = null;

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
  _resetUpstashEnvWarnings();
}
