/**
 * API-level invariance: final HTTP response body must be identical
 * with SHADOW_ADR0020 off vs on. Shadow may only add logs.
 *
 * We test the assembly path used by api/sentinel/verify.ts:
 *   processedResponse + attestation + billing = finalResponse
 * Shadow runs after finalResponse is built and must not alter it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildBillingEvent } from '../billing.js';
import { buildAttestationData } from '../eas/attest.js';
import { runShadowObservability } from './shadow.js';
import type { SentinelVerifyRequest, SentinelVerifyResponse } from '../types.js';

function baseProcessed(): SentinelVerifyResponse {
  return {
    id: 'sent_invar_001',
    verdict: 'UNCERTAIN',
    confidence: 0.55,
    reasoning: 'conditional allow without machine proof',
    objections: [
      {
        step_id: 'step_0',
        criterion: 'coverage must hold',
        score: 0.4,
        predicate: 'partial',
        quote: null,
        reasoning: 'weak support',
      },
    ],
    mode: 'action_authorization',
    tier: 'standard',
    meta: {
      duration_ms: 42,
      models_used: ['serv-nano', 'serv-swift'],
      verified_at: '2026-08-13T12:00:00.000Z',
      package_digest: '0x' + 'ab'.repeat(32),
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
  };
}

function baseRequest(): SentinelVerifyRequest {
  return {
    id: 'req_invar_001',
    claim: 'dispatch unit before deadline while keeping coverage',
    evidence: 'validator formal ok; storm watch open',
    mode: 'action_authorization',
    tier: 'standard',
    action_hash: '0x' + 'cd'.repeat(32),
    agent_context: {
      agent_id: 'adr0020.a1.pilot.v0',
      agent_runtime: 'a1-pilot',
      environment: 'paper',
      tags: ['adr0020', 'a1-pilot', 'caller_asserted'],
    },
    required_conditions: [
      {
        condition_id: 'deadline_met',
        required: true,
        proof_requirement: 'machine',
        evidence_bindings: [
          {
            evidence_id: 'evidence:eta_ok',
            bound_condition_id: 'deadline_met',
            syntactically_valid: true,
            freshness: 'fresh',
            contradicted: false,
            grade: 'machine',
          },
        ],
      },
      {
        condition_id: 'coverage_held',
        required: true,
        proof_requirement: 'machine',
        evidence_bindings: [],
      },
    ],
  };
}

/** Mirror verify.ts finalResponse assembly (no network side effects). */
function assembleFinalResponse(
  processed: SentinelVerifyResponse,
  request: SentinelVerifyRequest,
  opts: { attestIssued: boolean; paymentSettled: boolean; platform: 'direct' | 'openserv' | 'acp' },
) {
  const attestationData = buildAttestationData(request, processed);
  const billingEvent = buildBillingEvent(processed, {
    platform: opts.platform,
    agent_id: 'agent_test',
  });

  return {
    ...processed,
    attestation: {
      prepared: true,
      issued: opts.attestIssued,
      schema_uid: '0x3945d7be65761ff1a83a4d6e16a7d3adbe6ced982a7e139854b5bfe4c0748d2b',
      claim_hash: attestationData.claimHash,
      evidence_hash: attestationData.evidenceHash,
      ...(opts.attestIssued
        ? { uid: '0xattest_uid', tx_hash: '0xtx_hash' }
        : {}),
    },
    billing: {
      price_usd: billingEvent.price_usd,
      settled: opts.paymentSettled,
      platform: billingEvent.platform,
      ...(opts.paymentSettled ? { payment_method: 'x402-facilitator' as const } : {}),
    },
  };
}

describe('ADR-0020 handler HTTP body invariance', () => {
  const logs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs.length = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('flag off vs flag on: full finalResponse JSON body identical', () => {
    const processed = baseProcessed();
    const request = baseRequest();
    const assembleOpts = {
      attestIssued: false,
      paymentSettled: true,
      platform: 'direct' as const,
    };

    const baseline = assembleFinalResponse(processed, request, assembleOpts);
    const baselineJson = JSON.stringify(baseline);

    // Flag OFF path
    const offShadow = runShadowObservability({
      response: processed,
      request,
      requestId: 'req_off',
      env: { SHADOW_ADR0020: 'off' },
    });
    const offFinal = assembleFinalResponse(offShadow.response, request, assembleOpts);
    expect(JSON.stringify(offFinal)).toBe(baselineJson);
    expect(offShadow.shadow).toBeNull();
    expect(logs.some((l) => l.includes('adr0020.shadow'))).toBe(false);

    // Flag ON path — shadow after final assembly, must not alter body
    logs.length = 0;
    const onFinal = assembleFinalResponse(processed, request, assembleOpts);
    const onShadow = runShadowObservability({
      response: processed,
      request,
      requestId: 'req_on',
      env: { SHADOW_ADR0020: 'on' },
    });
    // Re-assemble from shadow.response (should equal processed)
    const onFinalAfterShadow = assembleFinalResponse(onShadow.response, request, assembleOpts);

    expect(JSON.stringify(onFinal)).toBe(baselineJson);
    expect(JSON.stringify(onFinalAfterShadow)).toBe(baselineJson);
    expect(onShadow.shadow?.would_escalate).toBe(true);
    expect(onShadow.shadow?.binding_source).toBe('caller_asserted');
    expect(onShadow.shadow?.eligible_for_q2_decision).toBe(false);
    expect(onShadow.mutation_detected).toBe(false);

    // Field-by-field critical surface
    for (const body of [offFinal, onFinalAfterShadow]) {
      expect(body.verdict).toBe(baseline.verdict);
      expect(body.reasoning).toBe(baseline.reasoning);
      expect(body.objections).toEqual(baseline.objections);
      expect(body.meta).toEqual(baseline.meta);
      expect(body.attestation).toEqual(baseline.attestation);
      expect(body.billing).toEqual(baseline.billing);
      expect(body.id).toBe(baseline.id);
      expect(body.confidence).toBe(baseline.confidence);
    }
  });

  it('flag on only adds shadow log, never changes status/verdict surface', () => {
    const processed = baseProcessed();
    const request = baseRequest();
    const body = assembleFinalResponse(processed, request, {
      attestIssued: true,
      paymentSettled: false,
      platform: 'openserv',
    });

    const before = JSON.stringify(body);
    const shadow = runShadowObservability({
      response: processed,
      request,
      env: { SHADOW_ADR0020: 'on' },
    });
    const after = assembleFinalResponse(shadow.response, request, {
      attestIssued: true,
      paymentSettled: false,
      platform: 'openserv',
    });

    expect(JSON.stringify(after)).toBe(before);
    expect(shadow.shadow?.rv_status).toBe('not_invoked_shadow');
    expect(shadow.shadow?.final_verdict).toBe(processed.verdict);
    // Shadow log present
    expect(logs.some((l) => l.includes('"type":"adr0020.shadow"') || l.includes('adr0020.shadow'))).toBe(
      true,
    );
  });
});
