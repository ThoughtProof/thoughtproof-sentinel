import { describe, it, expect, beforeEach } from 'vitest';
import {
  persistShadowEvent,
  probeShadowSink,
  toSinkPayload,
  isShadowSinkConfigured,
  resolveShadowSinkEnv,
  shadowEventKey,
  SHADOW_SINK_TTL_SECONDS,
  _resetShadowSinkClient,
} from './shadow-sink.js';
import type { ShadowEvent } from './shadow.js';

function baseEvent(over: Partial<ShadowEvent> = {}): ShadowEvent {
  return {
    schema_version: 'adr0020.shadow.v0',
    mode: 'shadow',
    would_escalate: true,
    eligibility_basis: 'caller_asserted_structure',
    rv_status: 'not_invoked_shadow',
    trigger_code: 'multi_conjunct_missing_machine_proof',
    judge_version: 'adr0020.q1.judge.v0.1',
    judge_logic_id: 'adr0020.q1.judge.v0+ts-port',
    source_verdict: 'UNCERTAIN',
    canonical_verdict: 'REVIEW',
    parent_verdict: 'UNCERTAIN',
    final_verdict: 'UNCERTAIN',
    action_hash: '0x' + 'ab'.repeat(32),
    required_count: 2,
    missing_caller_asserted_bound_count: 1,
    event_id: 'sh_test_001',
    shadow_status: 'ok',
    error_code: null,
    parent_receipt_id: 'sent_1',
    request_id: 'req_1',
    judge_latency_ms: 3,
    shadow_latency_ms: 5,
    has_structured_conditions: true,
    binding_source: 'caller_asserted',
    eligible_for_q2_decision: false,
    producer_id: 'adr0020.a1.pilot.v0',
    producer_allowed: true,
    ...over,
  };
}

class FakeRedis {
  store = new Map<string, string>();
  zsets = new Map<string, Map<string, number>>();
  counters = new Map<string, number>();
  expires = new Map<string, number>();
  failExec = false;
  slowMs = 0;

  pipeline() {
    const ops: Array<() => void> = [];
    const api = {
      set: (key: string, value: string, opts?: { ex?: number }) => {
        ops.push(() => {
          this.store.set(key, value);
          if (opts?.ex) this.expires.set(key, opts.ex);
        });
        return api;
      },
      zadd: (key: string, item: { score: number; member: string }) => {
        ops.push(() => {
          if (!this.zsets.has(key)) this.zsets.set(key, new Map());
          this.zsets.get(key)!.set(item.member, item.score);
        });
        return api;
      },
      expire: (key: string, sec: number) => {
        ops.push(() => this.expires.set(key, sec));
        return api;
      },
      incr: (key: string) => {
        ops.push(() => this.counters.set(key, (this.counters.get(key) ?? 0) + 1));
        return api;
      },
      zremrangebyrank: (_key: string, _start: number, _stop: number) => {
        ops.push(() => {});
        return api;
      },
      exec: async () => {
        if (this.slowMs) await new Promise((r) => setTimeout(r, this.slowMs));
        if (this.failExec) throw new Error('boom');
        for (const op of ops) op();
        return ops.map(() => 'OK');
      },
    };
    return api;
  }

  async ping() {
    return 'PONG';
  }

  async get(key: string) {
    return this.store.get(key) ?? null;
  }
}

describe('ADR-0020 Upstash shadow sink', () => {
  beforeEach(() => {
    _resetShadowSinkClient();
  });

  it('reports unconfigured without upstash env', () => {
    expect(isShadowSinkConfigured({})).toBe(false);
  });

  it('resolves env names with separation', () => {
    expect(resolveShadowSinkEnv({ VERCEL_ENV: 'production' })).toBe('production');
    expect(resolveShadowSinkEnv({ VERCEL_ENV: 'preview' })).toBe('preview');
    expect(resolveShadowSinkEnv({ SHADOW_SINK_ENV: 'test' })).toBe('test');
  });

  it('payload has no claim/evidence/mandate keys and pins ttl', () => {
    const p = toSinkPayload(baseEvent());
    const s = JSON.stringify(p);
    expect(s).not.toMatch(/claim|evidence|mandate|password|api_key/i);
    expect(p.sink).toBe('upstash');
    expect(p.sink_ttl_s).toBe(SHADOW_SINK_TTL_SECONDS);
    expect(SHADOW_SINK_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(p.action_hash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(p.eligible_for_q2_decision).toBe(false);
  });

  it('persist skips when unconfigured', async () => {
    const r = await persistShadowEvent(baseEvent(), {});
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.error_code).toBe('sink_unconfigured');
  });

  it('persist writes event + counters fail-open on success', async () => {
    const redis = new FakeRedis();
    const r = await persistShadowEvent(
      baseEvent(),
      {
        UPSTASH_REDIS_REST_URL: 'https://example',
        UPSTASH_REDIS_REST_TOKEN: 't',
        VERCEL_ENV: 'production',
      },
      { redis: redis as never, now: () => 1_700_000_000_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.skipped).toBeFalsy();
    const key = shadowEventKey('production', 'sh_test_001');
    expect(redis.store.has(key)).toBe(true);
    expect(redis.expires.get(key)).toBe(SHADOW_SINK_TTL_SECONDS);
    const body = JSON.parse(redis.store.get(key)!);
    expect(body.type).toBe('adr0020.shadow');
    expect(body.would_escalate).toBe(true);
    expect(redis.counters.get('sentinel:a1:production:c:total')).toBe(1);
    expect(redis.counters.get('sentinel:a1:production:c:eligible')).toBe(1);
    expect(redis.counters.get('sentinel:a1:production:c:ok')).toBe(1);
  });

  it('persist fail-open on redis error', async () => {
    const redis = new FakeRedis();
    redis.failExec = true;
    const r = await persistShadowEvent(
      baseEvent(),
      { UPSTASH_REDIS_REST_URL: 'https://example', UPSTASH_REDIS_REST_TOKEN: 't' },
      { redis: redis as never },
    );
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('sink_error');
  });

  it('persist fail-open on timeout', async () => {
    const redis = new FakeRedis();
    redis.slowMs = 50;
    const r = await persistShadowEvent(
      baseEvent(),
      { UPSTASH_REDIS_REST_URL: 'https://example', UPSTASH_REDIS_REST_TOKEN: 't' },
      { redis: redis as never, timeoutMs: 5 },
    );
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('sink_timeout');
  });

  it('probe reports configured+reachable with fake redis', async () => {
    const redis = new FakeRedis();
    const p = await probeShadowSink(
      { UPSTASH_REDIS_REST_URL: 'https://example', UPSTASH_REDIS_REST_TOKEN: 't', VERCEL_ENV: 'preview' },
      { redis: redis as never },
    );
    expect(p.configured).toBe(true);
    expect(p.reachable).toBe(true);
    expect(p.env_name).toBe('preview');
    expect(p.ttl_seconds).toBe(SHADOW_SINK_TTL_SECONDS);
  });
});
