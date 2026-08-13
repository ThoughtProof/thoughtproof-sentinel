/**
 * ADR-0020 Shadow Observability (observe-only)
 *
 * Feature flag default OFF (SHADOW_ADR0020 only — no aliases).
 * Never mutates Sentinel response. Never calls RV.
 * Fail-open for shadow errors: production gate already decided.
 * Default emit: console line + optional Upstash sink (fail-open, bounded).
 *
 * Placement: after final Sentinel verdict, before response serialization.
 *
 * Flag-off is a true no-op: no clone, no stringify, no judge.
 * action_hash in events is always sanitized (0x+64 hex).
 */

import { createHash } from 'node:crypto';
import {
  evaluateQ1Eligibility,
  countProofStats,
  canonicalizeVerdictForQ1,
  Q1_JUDGE_VERSION,
  type RequiredCondition,
  type Q1RuntimeInput,
} from './q1-judge.js';
import { PILOT_PRODUCER_ID } from './pilot-producer.js';
import type { SentinelVerifyRequest, SentinelVerifyResponse } from '../types.js';

export const SHADOW_SCHEMA_VERSION = 'adr0020.shadow.v0';
export const SHADOW_RUNNER_VERSION = 'adr0020.shadow.runner.v0';

/**
 * A1 canary: only allowlisted producers run the shadow path when flag is on.
 * Default allowlist = pilot only. Override via SHADOW_PRODUCER_ALLOWLIST=id1,id2
 * (comma-separated agent_id values). Empty override is ignored (keeps default).
 */
export const DEFAULT_SHADOW_PRODUCER_ALLOWLIST = [PILOT_PRODUCER_ID] as const;

/** Pinned hash of frozen JS judge source (experiment pack). TS port must stay equivalent. */
export const PINNED_JUDGE_LOGIC_ID = 'adr0020.q1.judge.v0+ts-port';

/** Canonical safe action-hash form for logs: 0x + 64 lowercase hex. */
export const ACTION_HASH_RE = /^0x[a-f0-9]{64}$/;

export type ShadowStatus = 'ok' | 'disabled' | 'error' | 'skipped';

export interface ShadowEvent {
  schema_version: string;
  mode: 'shadow';
  /**
   * Structure-signal under caller_asserted bindings.
   * NOT verified-proof eligibility. Read with eligibility_basis.
   */
  would_escalate: boolean;
  /**
   * Explicit basis for would_escalate.
   * v0 always caller_asserted_structure while binding_source is caller_asserted.
   */
  eligibility_basis: 'caller_asserted_structure' | 'server_verified_structure';
  rv_status: 'not_invoked_shadow';
  trigger_code: string;
  judge_version: string;
  judge_logic_id: string;
  /** Public API verdict on the response (ALLOW|BLOCK|UNCERTAIN). */
  source_verdict: string;
  /** Q1 class after canonicalizeVerdictForQ1 (UNCERTAIN→REVIEW). */
  canonical_verdict: string;
  /** @deprecated alias of source_verdict — kept for early consumers */
  parent_verdict: string;
  /** Always equals source_verdict — shadow never mutates final. */
  final_verdict: string;
  /**
   * Safe log form only: 0x + 64 hex (or null).
   * Never raw caller strings — sanitized via sanitizeActionHashForLog.
   */
  action_hash: string | null;
  required_count: number | null;
  /**
   * Count of required machine conditions lacking structurally-valid
   * caller-asserted bindings. NOT server-verified machine-proof count.
   * Internal judge stats use a historical name; event schema uses this only.
   */
  missing_caller_asserted_bound_count: number | null;
  event_id: string | null;
  shadow_status: ShadowStatus;
  error_code: string | null;
  parent_receipt_id: string | null;
  request_id: string | null;
  judge_latency_ms?: number;
  shadow_latency_ms?: number;
  has_structured_conditions: boolean;
  /**
   * Trust provenance of structured binding fields.
   * v0: caller_asserted — Q1 may measure structure, but must NOT drive Q2 decisions.
   */
  binding_source: 'caller_asserted' | 'server_verified';
  /** Always false while binding_source is caller_asserted. */
  eligible_for_q2_decision: boolean;
  /** Caller agent_id used for allowlist (safe short id; never free text claim). */
  producer_id: string | null;
  /** Whether producer_id was on the server allowlist at emit time. */
  producer_allowed: boolean;
}

export interface ShadowPassResult {
  /** Always the original snapshot — never mutated */
  response: SentinelVerifyResponse;
  shadow: ShadowEvent | null;
  shadow_status: ShadowStatus;
  error_code: string | null;
  mutation_detected: boolean;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Sanitize action-hash / package_digest for safe logging.
 * - 0x + 64 hex → lowercase as-is
 * - sha256: + 64 hex → normalize to 0x + hex
 * - anything else → 0x + sha256(raw) so PII/secrets never appear in logs
 * - null/empty → null
 */
export function sanitizeActionHashForLog(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (ACTION_HASH_RE.test(lower)) return lower;
  const m = /^sha256:([a-f0-9]{64})$/i.exec(t);
  if (m) return `0x${m[1].toLowerCase()}`;
  return `0x${sha256Hex(t)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Feature flag: default OFF.
 * ONLY SHADOW_ADR0020 — no undocumented aliases.
 * Accept 1/true/on/yes.
 */
export function isShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.SHADOW_ADR0020 ?? 'off').toString().trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** Resolve allowlisted producer agent_ids for A1 canary. */
export function getShadowProducerAllowlist(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const raw = (env.SHADOW_PRODUCER_ALLOWLIST ?? '').toString().trim();
  if (!raw) return DEFAULT_SHADOW_PRODUCER_ALLOWLIST;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : DEFAULT_SHADOW_PRODUCER_ALLOWLIST;
}

/** Extract producer id from request agent_context (agent_id only). */
export function extractProducerId(request: SentinelVerifyRequest): string | null {
  const id = request.agent_context?.agent_id;
  if (typeof id !== 'string') return null;
  const t = id.trim();
  return t ? t.slice(0, 128) : null;
}

/** True only if producer_id is present and on allowlist. */
export function isProducerAllowed(
  request: SentinelVerifyRequest,
  env: NodeJS.ProcessEnv = process.env,
): { allowed: boolean; producer_id: string | null } {
  const producer_id = extractProducerId(request);
  if (!producer_id) return { allowed: false, producer_id: null };
  const list = getShadowProducerAllowlist(env);
  return { allowed: list.includes(producer_id), producer_id };
}

export function deterministicEventId(args: {
  parent_receipt_id: string | null | undefined;
  action_hash: string | null | undefined;
  judge_version: string;
  shadow_schema_version: string;
}): string {
  const material = [
    String(args.parent_receipt_id ?? ''),
    String(args.action_hash ?? ''),
    String(args.judge_version ?? ''),
    String(args.shadow_schema_version ?? ''),
  ].join('\n');
  return `sh_${sha256Hex(material).slice(0, 32)}`;
}

/**
 * Extract reason_code for Q1 from response meta (promotion / budget / fallback).
 */
export function extractReasonCode(response: SentinelVerifyResponse): string {
  if (response.meta?.promotion?.reason) return String(response.meta.promotion.reason);
  if (response.meta?.engine_budget?.reason) return String(response.meta.engine_budget.reason);
  if (response.meta?.promotion?.cascade_reason) {
    return String(response.meta.promotion.cascade_reason);
  }
  return 'unknown';
}

export function buildRuntimeInput(
  response: SentinelVerifyResponse,
  request: SentinelVerifyRequest,
): Q1RuntimeInput & { canonical_verdict: string; source_verdict: string } {
  const conditions = (request.required_conditions ?? []) as RequiredCondition[];
  const action_hash_raw =
    (typeof request.action_hash === 'string' && request.action_hash) ||
    response.meta?.package_digest ||
    null;
  const source_verdict = response.verdict;
  // INTERNAL only — never take caller-supplied canonical as source of truth.
  const canonical_verdict = canonicalizeVerdictForQ1(source_verdict);
  return {
    // Judge re-canonicalizes from source; do not pre-rewrite the source field.
    sentinel_verdict: source_verdict,
    source_verdict,
    canonical_verdict,
    reason_code: extractReasonCode(response),
    required_conditions: conditions,
    // Only sanitized form — never raw caller strings in events/logs
    action_hash: sanitizeActionHashForLog(action_hash_raw),
    case_id: request.id,
  };
}

/**
 * Default emit path:
 * 1) console JSON line (best-effort UI/log drain)
 * 2) Upstash structured sink (fail-open, bounded timeout) when configured
 *
 * Never throws. Does not await Redis on the hot path beyond fire-and-forget;
 * use emitShadowEventAsync when a test/gate needs completion.
 */
export function emitShadowEvent(event: ShadowEvent, env: NodeJS.ProcessEnv = process.env): void {
  // Single-line JSON. No raw mandate/evidence fields exist on ShadowEvent.
  try {
    console.log(JSON.stringify({ type: 'adr0020.shadow', ...event }));
  } catch {
    /* ignore logger failures */
  }
  // Dynamic import avoided — sink is light and already a dep via auth rate-limit.
  // Fire-and-forget; sink is fail-open internally.
  void import('./shadow-sink.js')
    .then(({ persistShadowEvent }) => persistShadowEvent(event, env))
    .catch(() => {
      /* ignore */
    });
}

/** Awaitable emit for tests/gates. Still fail-open (resolves even on sink error). */
export async function emitShadowEventAsync(
  event: ShadowEvent,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    console.log(JSON.stringify({ type: 'adr0020.shadow', ...event }));
  } catch {
    /* ignore */
  }
  try {
    const { persistShadowEvent } = await import('./shadow-sink.js');
    await persistShadowEvent(event, env);
  } catch {
    /* ignore */
  }
}

/**
 * Observe-only shadow pass.
 *
 * Flag OFF → true no-op: return original response reference, no clone/stringify/judge.
 * Flag ON → clone for mutation detection; never mutate returned response.
 */
export function runShadowObservability(args: {
  response: SentinelVerifyResponse;
  request: SentinelVerifyRequest;
  requestId?: string;
  env?: NodeJS.ProcessEnv;
  emit?: (event: ShadowEvent) => void;
  now?: () => number;
}): ShadowPassResult {
  const env = args.env ?? process.env;
  // FIRST operation: flag check — no clone/stringify when disabled (504-track hygiene)
  if (!isShadowEnabled(env)) {
    return {
      response: args.response,
      shadow: null,
      shadow_status: 'disabled',
      error_code: 'flag_off',
      mutation_detected: false,
    };
  }

  // A1 canary: technical producer allowlist (default = pilot only)
  const { allowed: producerAllowed, producer_id } = isProducerAllowed(args.request, env);
  if (!producerAllowed) {
    return {
      response: args.response,
      shadow: null,
      shadow_status: 'skipped',
      error_code: producer_id ? 'producer_not_allowlisted' : 'producer_missing',
      mutation_detected: false,
    };
  }

  const t0 = (args.now ?? Date.now)();
  const original = deepClone(args.response);
  const originalFp = stableStringify(original);
  const emit = args.emit ?? ((e: ShadowEvent) => emitShadowEvent(e, env));

  try {
    const runtime = buildRuntimeInput(original, args.request);
    const hasStructured =
      Array.isArray(runtime.required_conditions) && runtime.required_conditions.length > 0;
    const safeActionHash =
      typeof runtime.action_hash === 'string' ? runtime.action_hash : null;

    const j0 = (args.now ?? Date.now)();
    let decision;
    try {
      decision = evaluateQ1Eligibility(runtime);
    } catch {
      const errEvent: ShadowEvent = {
        schema_version: SHADOW_SCHEMA_VERSION,
        mode: 'shadow',
        would_escalate: false,
        eligibility_basis: 'caller_asserted_structure',
        rv_status: 'not_invoked_shadow',
        trigger_code: 'invalid_input',
        judge_version: Q1_JUDGE_VERSION,
        judge_logic_id: PINNED_JUDGE_LOGIC_ID,
        source_verdict: runtime.source_verdict,
        canonical_verdict: runtime.canonical_verdict,
        parent_verdict: runtime.source_verdict,
        final_verdict: runtime.source_verdict,
        action_hash: safeActionHash,
        required_count: null,
        missing_caller_asserted_bound_count: null,
        event_id: null,
        shadow_status: 'error',
        error_code: 'judge_throw',
        parent_receipt_id: original.id ?? null,
        request_id: args.requestId ?? null,
        judge_latency_ms: (args.now ?? Date.now)() - j0,
        shadow_latency_ms: (args.now ?? Date.now)() - t0,
        has_structured_conditions: hasStructured,
        binding_source: 'caller_asserted',
        eligible_for_q2_decision: false,
        producer_id,
        producer_allowed: true,
      };
      try {
        emit(errEvent);
      } catch {
        /* logger throw ignored */
      }
      const out = deepClone(original);
      return {
        response: out,
        shadow: errEvent,
        shadow_status: 'error',
        error_code: 'judge_throw',
        mutation_detected: stableStringify(out) !== originalFp,
      };
    }
    const judge_latency_ms = (args.now ?? Date.now)() - j0;
    const stats = countProofStats(runtime.required_conditions);
    const parent_receipt_id = original.id ?? null;
    const event_id = deterministicEventId({
      parent_receipt_id,
      action_hash: safeActionHash,
      judge_version: Q1_JUDGE_VERSION,
      shadow_schema_version: SHADOW_SCHEMA_VERSION,
    });

    const event: ShadowEvent = {
      schema_version: SHADOW_SCHEMA_VERSION,
      mode: 'shadow',
      would_escalate: decision.eligible === true,
      eligibility_basis: 'caller_asserted_structure',
      rv_status: 'not_invoked_shadow',
      trigger_code: decision.triggerCode,
      judge_version: Q1_JUDGE_VERSION,
      judge_logic_id: PINNED_JUDGE_LOGIC_ID,
      source_verdict: runtime.source_verdict,
      canonical_verdict: runtime.canonical_verdict,
      parent_verdict: runtime.source_verdict,
      final_verdict: runtime.source_verdict,
      action_hash: safeActionHash,
      required_count: stats.required_count,
      missing_caller_asserted_bound_count: stats.missing_machine_proof_count,
      event_id,
      shadow_status: 'ok',
      error_code: null,
      parent_receipt_id,
      request_id: args.requestId ?? null,
      judge_latency_ms,
      shadow_latency_ms: (args.now ?? Date.now)() - t0,
      has_structured_conditions: hasStructured,
      binding_source: 'caller_asserted',
      eligible_for_q2_decision: false,
      producer_id,
      producer_allowed: true,
    };

    try {
      emit(event);
    } catch {
      event.shadow_status = 'error';
      event.error_code = 'logger_throw';
      const out = deepClone(original);
      return {
        response: out,
        shadow: event,
        shadow_status: 'error',
        error_code: 'logger_throw',
        mutation_detected: stableStringify(out) !== originalFp,
      };
    }

    const out = deepClone(original);
    const mutation_detected = stableStringify(out) !== originalFp;
    if (mutation_detected) {
      // Absolute last resort — never return mutated response
      return {
        response: deepClone(args.response),
        shadow: { ...event, shadow_status: 'error', error_code: 'mutation_blocked' },
        shadow_status: 'error',
        error_code: 'mutation_blocked',
        mutation_detected: true,
      };
    }

    return {
      response: out,
      shadow: event,
      shadow_status: 'ok',
      error_code: null,
      mutation_detected: false,
    };
  } catch {
    const out = deepClone(original);
    return {
      response: out,
      shadow: null,
      shadow_status: 'error',
      error_code: 'shadow_internal_error',
      mutation_detected: stableStringify(out) !== originalFp,
    };
  }
}

export { stableStringify, deepClone };
