import { describe, it, expect } from 'vitest';
import {
  runShadowObservability,
  isShadowEnabled,
  deterministicEventId,
  extractReasonCode,
  SHADOW_SCHEMA_VERSION,
} from './shadow.js';
import type { SentinelVerifyRequest, SentinelVerifyResponse } from '../types.js';

function binding(eid: string, cond: string) {
  return {
    evidence_id: eid,
    bound_condition_id: cond,
    syntactically_valid: true as const,
    freshness: 'fresh' as const,
    contradicted: false,
    grade: 'machine' as const,
  };
}

function baseRequest(overrides: Partial<SentinelVerifyRequest> = {}): SentinelVerifyRequest {
  return {
    claim: 'dispatch unit',
    evidence: 'validator ok',
    mode: 'action_authorization',
    required_conditions: [
      {
        condition_id: 'alpha_required',
        required: true,
        proof_requirement: 'machine',
        evidence_bindings: [binding('evidence:alpha_ok', 'alpha_required')],
      },
      {
        condition_id: 'beta_required',
        required: true,
        proof_requirement: 'machine',
        evidence_bindings: [],
      },
    ],
    action_hash: '0x' + 'ab'.repeat(32),
    ...overrides,
  };
}

function baseResponse(overrides: Partial<SentinelVerifyResponse> = {}): SentinelVerifyResponse {
  return {
    id: 'sent_test_001',
    verdict: 'UNCERTAIN',
    confidence: 0.5,
    reasoning: 'conditional',
    objections: [],
    mode: 'action_authorization',
    tier: 'standard',
    meta: {
      duration_ms: 12,
      models_used: ['serv-nano'],
      verified_at: new Date().toISOString(),
      promotion: {
        cascade_reason: 'agreement_conditional_allow',
        internal_verdict: 'CONDITIONAL_ALLOW',
        mapped_verdict: 'UNCERTAIN',
        public_verdict: 'UNCERTAIN',
        promoted: true,
        reason: 'conditional_allow_no_machine_proof',
        steps_all_pass: false,
        machine_condition_proof_present: false,
        machine_condition_proof_accepted: false,
      },
    },
    ...overrides,
  };
}

describe('ADR-0020 shadow observability', () => {
  it('flag default off; false/0/empty do not enable', () => {
    expect(isShadowEnabled({})).toBe(false);
    expect(isShadowEnabled({ SHADOW_ADR0020: 'off' })).toBe(false);
    expect(isShadowEnabled({ SHADOW_ADR0020: 'false' })).toBe(false);
    expect(isShadowEnabled({ SHADOW_ADR0020: '0' })).toBe(false);
    expect(isShadowEnabled({ SHADOW_ADR0020: '' })).toBe(false);
    expect(isShadowEnabled({ SHADOW_ADR0020: 'on' })).toBe(true);
    expect(isShadowEnabled({ SHADOW_ADR0020: '1' })).toBe(true);
  });

  it('disabled when flag off — no event, response unchanged', () => {
    const response = baseResponse();
    const request = baseRequest();
    const events: unknown[] = [];
    const result = runShadowObservability({
      response,
      request,
      env: { SHADOW_ADR0020: 'off' },
      emit: (e) => events.push(e),
    });
    expect(result.shadow_status).toBe('disabled');
    expect(result.shadow).toBeNull();
    expect(events).toHaveLength(0);
    expect(result.response.verdict).toBe(response.verdict);
    expect(result.response.id).toBe(response.id);
    expect(result.mutation_detected).toBe(false);
  });

  it('when on: escalates eligible case, does not mutate response', () => {
    const response = baseResponse();
    const request = baseRequest();
    const events: Array<{ would_escalate: boolean; final_verdict: string; rv_status: string }> = [];
    const result = runShadowObservability({
      response,
      request,
      requestId: 'req_1',
      env: { SHADOW_ADR0020: 'on' },
      emit: (e) => events.push(e),
    });
    expect(result.shadow_status).toBe('ok');
    expect(result.shadow?.would_escalate).toBe(true);
    expect(result.shadow?.trigger_code).toBe('multi_conjunct_missing_machine_proof');
    expect(result.shadow?.rv_status).toBe('not_invoked_shadow');
    expect(result.shadow?.source_verdict).toBe('UNCERTAIN');
    expect(result.shadow?.canonical_verdict).toBe('REVIEW');
    expect(result.shadow?.final_verdict).toBe(result.shadow?.source_verdict);
    expect(result.shadow?.schema_version).toBe(SHADOW_SCHEMA_VERSION);
    expect(result.shadow?.binding_source).toBe('caller_asserted');
    expect(result.shadow?.eligible_for_q2_decision).toBe(false);
    expect(result.response.verdict).toBe('UNCERTAIN');
    expect(result.response.reasoning).toBe(response.reasoning);
    expect(result.mutation_detected).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].would_escalate).toBe(true);
  });

  it('ALLOW never escalates', () => {
    const result = runShadowObservability({
      response: baseResponse({
        verdict: 'ALLOW',
        meta: {
          duration_ms: 1,
          models_used: [],
          verified_at: new Date().toISOString(),
        },
      }),
      request: baseRequest(),
      env: { SHADOW_ADR0020: 'on' },
      emit: () => {},
    });
    expect(result.shadow?.would_escalate).toBe(false);
    expect(result.shadow?.trigger_code).toBe('not_review');
    expect(result.response.verdict).toBe('ALLOW');
  });

  it('missing structured conditions → not multi-conjunct escalate', () => {
    const result = runShadowObservability({
      response: baseResponse(),
      request: baseRequest({ required_conditions: undefined }),
      env: { SHADOW_ADR0020: 'on' },
      emit: () => {},
    });
    // empty array path via buildRuntimeInput
    expect(result.shadow?.would_escalate).toBe(false);
    expect(result.shadow?.has_structured_conditions).toBe(false);
  });

  it('judge throw / logger throw keep response identical', () => {
    const response = baseResponse();
    const request = baseRequest();

    // logger throw
    const r1 = runShadowObservability({
      response,
      request,
      env: { SHADOW_ADR0020: 'on' },
      emit: () => {
        throw new Error('log fail');
      },
    });
    expect(r1.response.verdict).toBe(response.verdict);
    expect(r1.response.id).toBe(response.id);
    expect(r1.shadow_status).toBe('error');
    expect(r1.error_code).toBe('logger_throw');
  });

  it('deterministic event ids', () => {
    const a = deterministicEventId({
      parent_receipt_id: 'sent_1',
      action_hash: '0xabc',
      judge_version: 'adr0020.q1.judge.v0',
      shadow_schema_version: SHADOW_SCHEMA_VERSION,
    });
    const b = deterministicEventId({
      parent_receipt_id: 'sent_1',
      action_hash: '0xabc',
      judge_version: 'adr0020.q1.judge.v0',
      shadow_schema_version: SHADOW_SCHEMA_VERSION,
    });
    expect(a).toBe(b);
    expect(a.startsWith('sh_')).toBe(true);
  });

  it('extractReasonCode prefers promotion.reason', () => {
    expect(extractReasonCode(baseResponse())).toBe('conditional_allow_no_machine_proof');
  });

  it('event has no raw evidence keys', () => {
    const events: Record<string, unknown>[] = [];
    runShadowObservability({
      response: baseResponse(),
      request: baseRequest(),
      env: { SHADOW_ADR0020: 'on' },
      emit: (e) => events.push(e as unknown as Record<string, unknown>),
    });
    const s = JSON.stringify(events[0]);
    expect(s).not.toMatch(/evidence_pack|raw_mandate|claim\"|password|api_key/i);
    expect(events[0]).not.toHaveProperty('evidence');
    expect(events[0]).not.toHaveProperty('claim');
  });
});
