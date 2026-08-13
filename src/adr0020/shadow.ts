/**
 * ADR-0020 Shadow Observability (observe-only)
 *
 * Feature flag default OFF (SHADOW_ADR0020 / process.env).
 * Never mutates Sentinel response. Never calls RV. Never external network.
 * Fail-open for shadow errors: production gate already decided.
 *
 * Placement: after final Sentinel verdict, before response serialization.
 */

import { createHash } from 'node:crypto';
import {
  evaluateQ1Eligibility,
  countProofStats,
  Q1_JUDGE_VERSION,
  type RequiredCondition,
  type Q1RuntimeInput,
} from './q1-judge.js';
import type { SentinelVerifyRequest, SentinelVerifyResponse } from '../types.js';

export const SHADOW_SCHEMA_VERSION = 'adr0020.shadow.v0';
export const SHADOW_RUNNER_VERSION = 'adr0020.shadow.runner.v0';

/** Pinned hash of frozen JS judge source (experiment pack). TS port must stay equivalent. */
export const PINNED_JUDGE_LOGIC_ID = 'adr0020.q1.judge.v0+ts-port';

export type ShadowStatus = 'ok' | 'disabled' | 'error' | 'skipped';

export interface ShadowEvent {
  schema_version: string;
  mode: 'shadow';
  would_escalate: boolean;
  rv_status: 'not_invoked_shadow';
  trigger_code: string;
  judge_version: string;
  judge_logic_id: string;
  parent_verdict: string;
  final_verdict: string;
  action_hash: string | null;
  required_count: number | null;
  missing_machine_proof_count: number | null;
  event_id: string | null;
  shadow_status: ShadowStatus;
  error_code: string | null;
  parent_receipt_id: string | null;
  request_id: string | null;
  judge_latency_ms?: number;
  shadow_latency_ms?: number;
  has_structured_conditions: boolean;
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

/** Feature flag: default OFF. Accept 1/true/on/yes. */
export function isShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.SHADOW_ADR0020 ?? env.ADR0020_SHADOW ?? 'off').toString().trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
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
  // cascade path sometimes only on promotion.cascade_reason
  if (response.meta?.promotion?.cascade_reason) {
    return String(response.meta.promotion.cascade_reason);
  }
  return 'unknown';
}

export function buildRuntimeInput(
  response: SentinelVerifyResponse,
  request: SentinelVerifyRequest,
): Q1RuntimeInput {
  const conditions = (request.required_conditions ?? []) as RequiredCondition[];
  const action_hash =
    (typeof request.action_hash === 'string' && request.action_hash) ||
    response.meta?.package_digest ||
    null;
  return {
    sentinel_verdict: response.verdict,
    reason_code: extractReasonCode(response),
    required_conditions: conditions,
    action_hash,
    case_id: request.id,
  };
}

/** Structured log sink — Vercel/runtime logs only. No external network. */
export function emitShadowEvent(event: ShadowEvent): void {
  // Single-line JSON for log drains. No raw mandate/evidence fields exist on ShadowEvent.
  console.log(JSON.stringify({ type: 'adr0020.shadow', ...event }));
}

/**
 * Observe-only shadow pass.
 * Always returns the original response snapshot (clone equality-checked).
 */
export function runShadowObservability(args: {
  response: SentinelVerifyResponse;
  request: SentinelVerifyRequest;
  requestId?: string;
  env?: NodeJS.ProcessEnv;
  emit?: (event: ShadowEvent) => void;
  now?: () => number;
}): ShadowPassResult {
  const t0 = (args.now ?? Date.now)();
  const original = deepClone(args.response);
  const originalFp = stableStringify(original);
  const emit = args.emit ?? emitShadowEvent;

  if (!isShadowEnabled(args.env ?? process.env)) {
    return {
      response: original,
      shadow: null,
      shadow_status: 'disabled',
      error_code: 'flag_off',
      mutation_detected: false,
    };
  }

  try {
    const runtime = buildRuntimeInput(original, args.request);
    const hasStructured =
      Array.isArray(runtime.required_conditions) && runtime.required_conditions.length > 0;

    const j0 = (args.now ?? Date.now)();
    let decision;
    try {
      decision = evaluateQ1Eligibility(runtime);
    } catch {
      const errEvent: ShadowEvent = {
        schema_version: SHADOW_SCHEMA_VERSION,
        mode: 'shadow',
        would_escalate: false,
        rv_status: 'not_invoked_shadow',
        trigger_code: 'invalid_input',
        judge_version: Q1_JUDGE_VERSION,
        judge_logic_id: PINNED_JUDGE_LOGIC_ID,
        parent_verdict: original.verdict,
        final_verdict: original.verdict,
        action_hash: runtime.action_hash ?? null,
        required_count: null,
        missing_machine_proof_count: null,
        event_id: null,
        shadow_status: 'error',
        error_code: 'judge_throw',
        parent_receipt_id: original.id ?? null,
        request_id: args.requestId ?? null,
        judge_latency_ms: (args.now ?? Date.now)() - j0,
        shadow_latency_ms: (args.now ?? Date.now)() - t0,
        has_structured_conditions: hasStructured,
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
      action_hash: runtime.action_hash,
      judge_version: Q1_JUDGE_VERSION,
      shadow_schema_version: SHADOW_SCHEMA_VERSION,
    });

    const event: ShadowEvent = {
      schema_version: SHADOW_SCHEMA_VERSION,
      mode: 'shadow',
      would_escalate: decision.eligible === true,
      rv_status: 'not_invoked_shadow',
      trigger_code: decision.triggerCode,
      judge_version: Q1_JUDGE_VERSION,
      judge_logic_id: PINNED_JUDGE_LOGIC_ID,
      parent_verdict: original.verdict,
      final_verdict: original.verdict,
      action_hash: runtime.action_hash ?? null,
      required_count: stats.required_count,
      missing_machine_proof_count: stats.missing_machine_proof_count,
      event_id,
      shadow_status: 'ok',
      error_code: null,
      parent_receipt_id,
      request_id: args.requestId ?? null,
      judge_latency_ms,
      shadow_latency_ms: (args.now ?? Date.now)() - t0,
      has_structured_conditions: hasStructured,
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
