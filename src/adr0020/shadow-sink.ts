/**
 * ADR-0020 A1 Upstash shadow sink (structured metrics store).
 *
 * - Fail-open: sink errors never throw to callers
 * - Bounded write: pipeline + hard timeout
 * - No raw claim/evidence/mandate/PII (ShadowEvent only)
 * - Key prefix separated by environment
 * - TTL default 30 days
 * - Independent of SHADOW_ADR0020 flag enablement checks (caller decides when to emit)
 */

import { Redis } from '@upstash/redis';
import type { ShadowEvent } from './shadow.js';

export const SHADOW_SINK_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d
export const SHADOW_SINK_WRITE_TIMEOUT_MS = 200;
/** Soft bound on recent event-id index length (per env). */
export const SHADOW_SINK_INDEX_MAX = 5_000;

export type ShadowSinkEnvName = 'production' | 'preview' | 'development' | 'test' | 'unknown';

export interface ShadowSinkWriteResult {
  ok: boolean;
  skipped?: boolean;
  error_code?: string;
  key?: string;
  latency_ms?: number;
}

export interface ShadowSinkDeps {
  redis?: Pick<Redis, 'pipeline' | 'ping' | 'get'>;
  now?: () => number;
  timeoutMs?: number;
}

let _redis: Redis | null = null;
let _redisChecked = false;

/** Test-only reset of lazy client. */
export function _resetShadowSinkClient(): void {
  _redis = null;
  _redisChecked = false;
}

export function resolveShadowSinkEnv(env: NodeJS.ProcessEnv = process.env): ShadowSinkEnvName {
  const explicit = (env.SHADOW_SINK_ENV || env.SENTINEL_SHADOW_ENV || '').toString().trim().toLowerCase();
  if (
    explicit === 'production' ||
    explicit === 'preview' ||
    explicit === 'development' ||
    explicit === 'test'
  ) {
    return explicit;
  }
  const vercel = (env.VERCEL_ENV || '').toString().trim().toLowerCase();
  if (vercel === 'production' || vercel === 'preview' || vercel === 'development') {
    return vercel;
  }
  if (env.NODE_ENV === 'test') return 'test';
  if (env.NODE_ENV === 'development') return 'development';
  if (env.NODE_ENV === 'production') return 'production';
  return 'unknown';
}

export function isShadowSinkConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}

export function shadowSinkKeyPrefix(envName: ShadowSinkEnvName): string {
  return `sentinel:a1:${envName}`;
}

export function shadowEventKey(envName: ShadowSinkEnvName, eventId: string): string {
  return `${shadowSinkKeyPrefix(envName)}:evt:${eventId}`;
}

export function shadowIndexKey(envName: ShadowSinkEnvName): string {
  return `${shadowSinkKeyPrefix(envName)}:idx:ts`;
}

export function shadowCounterKey(
  envName: ShadowSinkEnvName,
  name: 'total' | 'eligible' | 'error' | 'ok',
): string {
  return `${shadowSinkKeyPrefix(envName)}:c:${name}`;
}

function getRedis(env: NodeJS.ProcessEnv = process.env, deps?: ShadowSinkDeps): Redis | null {
  if (deps?.redis) return deps.redis as Redis;
  if (_redisChecked) return _redis;
  _redisChecked = true;
  if (!isShadowSinkConfigured(env)) {
    _redis = null;
    return null;
  }
  _redis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL!,
    token: env.UPSTASH_REDIS_REST_TOKEN!,
  });
  return _redis;
}

/** Strip anything that must never land in the sink (defense in depth). */
export function toSinkPayload(event: ShadowEvent): Record<string, unknown> {
  return {
    type: 'adr0020.shadow',
    schema_version: event.schema_version,
    mode: event.mode,
    would_escalate: event.would_escalate,
    eligibility_basis: event.eligibility_basis,
    rv_status: event.rv_status,
    trigger_code: event.trigger_code,
    judge_version: event.judge_version,
    judge_logic_id: event.judge_logic_id,
    source_verdict: event.source_verdict,
    canonical_verdict: event.canonical_verdict,
    parent_verdict: event.parent_verdict,
    final_verdict: event.final_verdict,
    action_hash: event.action_hash,
    required_count: event.required_count,
    missing_caller_asserted_bound_count: event.missing_caller_asserted_bound_count,
    event_id: event.event_id,
    shadow_status: event.shadow_status,
    error_code: event.error_code,
    parent_receipt_id: event.parent_receipt_id,
    request_id: event.request_id,
    judge_latency_ms: event.judge_latency_ms ?? null,
    shadow_latency_ms: event.shadow_latency_ms ?? null,
    has_structured_conditions: event.has_structured_conditions,
    binding_source: event.binding_source,
    eligible_for_q2_decision: event.eligible_for_q2_decision,
    producer_id: event.producer_id,
    producer_allowed: event.producer_allowed,
    // sink metadata
    sink: 'upstash',
    sink_ttl_s: SHADOW_SINK_TTL_SECONDS,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('shadow_sink_timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Persist one shadow event. Fail-open: never throws.
 * No-ops (skipped) when Upstash is not configured.
 */
export async function persistShadowEvent(
  event: ShadowEvent,
  env: NodeJS.ProcessEnv = process.env,
  deps: ShadowSinkDeps = {},
): Promise<ShadowSinkWriteResult> {
  const t0 = (deps.now ?? Date.now)();
  try {
    if (!isShadowSinkConfigured(env) && !deps.redis) {
      return { ok: true, skipped: true, error_code: 'sink_unconfigured' };
    }
    const redis = getRedis(env, deps);
    if (!redis) {
      return { ok: true, skipped: true, error_code: 'sink_unconfigured' };
    }

    const envName = resolveShadowSinkEnv(env);
    const eventId =
      (typeof event.event_id === 'string' && event.event_id.trim()) ||
      `anon_${(deps.now ?? Date.now)()}`;
    const key = shadowEventKey(envName, eventId);
    const idx = shadowIndexKey(envName);
    const payload = JSON.stringify(toSinkPayload(event));
    const ts = (deps.now ?? Date.now)();
    const ttl = SHADOW_SINK_TTL_SECONDS;

    const pipe = redis.pipeline();
    pipe.set(key, payload, { ex: ttl });
    pipe.zadd(idx, { score: ts, member: eventId });
    // refresh index TTL so empty indexes don't linger forever without events
    pipe.expire(idx, ttl);
    pipe.incr(shadowCounterKey(envName, 'total'));
    pipe.expire(shadowCounterKey(envName, 'total'), ttl);
    if (event.would_escalate === true) {
      pipe.incr(shadowCounterKey(envName, 'eligible'));
      pipe.expire(shadowCounterKey(envName, 'eligible'), ttl);
    }
    if (event.shadow_status === 'error') {
      pipe.incr(shadowCounterKey(envName, 'error'));
      pipe.expire(shadowCounterKey(envName, 'error'), ttl);
    } else if (event.shadow_status === 'ok') {
      pipe.incr(shadowCounterKey(envName, 'ok'));
      pipe.expire(shadowCounterKey(envName, 'ok'), ttl);
    }
    // bound index growth (best-effort; fail-open if unsupported)
    pipe.zremrangebyrank(idx, 0, -SHADOW_SINK_INDEX_MAX - 1);

    const timeoutMs = deps.timeoutMs ?? SHADOW_SINK_WRITE_TIMEOUT_MS;
    await withTimeout(pipe.exec(), timeoutMs);

    return {
      ok: true,
      key,
      latency_ms: (deps.now ?? Date.now)() - t0,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'sink_error';
    const code = msg.includes('shadow_sink_timeout') ? 'sink_timeout' : 'sink_error';
    return {
      ok: false,
      error_code: code,
      latency_ms: (deps.now ?? Date.now)() - t0,
    };
  }
}

/**
 * Readiness probe for gate checks. Fail-open style result object; does not throw.
 */
export async function probeShadowSink(
  env: NodeJS.ProcessEnv = process.env,
  deps: ShadowSinkDeps = {},
): Promise<{
  configured: boolean;
  reachable: boolean;
  env_name: ShadowSinkEnvName;
  ttl_seconds: number;
  error_code?: string;
}> {
  const envName = resolveShadowSinkEnv(env);
  if (!isShadowSinkConfigured(env) && !deps.redis) {
    return {
      configured: false,
      reachable: false,
      env_name: envName,
      ttl_seconds: SHADOW_SINK_TTL_SECONDS,
      error_code: 'sink_unconfigured',
    };
  }
  try {
    const redis = getRedis(env, deps);
    if (!redis || typeof (redis as Redis).ping !== 'function') {
      // test double without ping — treat as reachable if provided
      if (deps.redis) {
        return {
          configured: true,
          reachable: true,
          env_name: envName,
          ttl_seconds: SHADOW_SINK_TTL_SECONDS,
        };
      }
      return {
        configured: false,
        reachable: false,
        env_name: envName,
        ttl_seconds: SHADOW_SINK_TTL_SECONDS,
        error_code: 'sink_unconfigured',
      };
    }
    const timeoutMs = deps.timeoutMs ?? SHADOW_SINK_WRITE_TIMEOUT_MS;
    await withTimeout((redis as Redis).ping(), timeoutMs);
    return {
      configured: true,
      reachable: true,
      env_name: envName,
      ttl_seconds: SHADOW_SINK_TTL_SECONDS,
    };
  } catch {
    return {
      configured: true,
      reachable: false,
      env_name: envName,
      ttl_seconds: SHADOW_SINK_TTL_SECONDS,
      error_code: 'sink_unreachable',
    };
  }
}
