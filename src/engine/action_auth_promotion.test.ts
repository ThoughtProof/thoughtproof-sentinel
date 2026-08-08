/**
 * ADR-0019 promotion-layer tests (2026-08-08 addendum).
 *
 * Mandatory cases:
 * 1. BLOCK + ALLOW → REVIEW
 * 2. BLOCK + CONDITIONAL_ALLOW → REVIEW
 * 3. agreement_conditional_allow without proof → REVIEW
 * 4. agreement_allow → ALLOW
 * 5. DQL behavior unchanged (promotion helper is Sentinel-only / pure)
 * 6. No LLM text can activate the proof exception
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveActionAuthPromotion,
  acceptsMachineConditionProof,
  canPromoteAllStepsPass,
  type StepLite,
} from './verdict.js';

vi.mock('pot-cli/plv', () => ({
  evaluateItem: vi.fn(),
}));

vi.mock('pot-cli/cascade', () => ({
  runCascade: vi.fn(),
}));

vi.mock('pot-cli/verdict', () => ({
  toPublicVerdict: vi.fn((internal: string) => {
    const map: Record<string, string> = {
      ALLOW: 'ALLOW',
      CONDITIONAL_ALLOW: 'ALLOW',
      HOLD: 'UNCERTAIN',
      BLOCK: 'BLOCK',
      DISSENT: 'UNCERTAIN',
    };
    return {
      verdict: map[internal] ?? 'UNCERTAIN',
      metadata: { schema_version: 'v2', confidence: 'high' },
    };
  }),
}));

import { verify } from './index.js';
import { runCascade } from 'pot-cli/cascade';
import type { SentinelVerifyRequest } from '../types.js';

const mockRunCascade = vi.mocked(runCascade);

const allPass: StepLite[] = [
  { step_id: 'step_0', score: 0.9, predicate: 'faithful' },
  { step_id: 'step_1', score: 0.9, predicate: 'faithful' },
  { step_id: 'step_2', score: 0.9, predicate: 'faithful' },
  { step_id: 'step_3', score: 0.9, predicate: 'faithful' },
];

function makeItemResult(verdict: string, score = 0.9) {
  return {
    id: 'aa-test',
    verdict,
    verdict_reasoning: `Test reasoning for ${verdict}`,
    step_evaluations: allPass.map((s) => ({
      step_id: s.step_id,
      predicate: s.predicate,
      score,
      quote: 'q',
      reasoning: 'ok',
    })),
    provenance_violations: [],
    overall_score: score,
    tier1_stats: undefined,
  };
}

function cascadeStub(args: {
  verdict: string;
  reason: string;
  primary: string;
  secondary?: string;
}) {
  return {
    verdict: args.verdict,
    reason: args.reason,
    primary: makeItemResult(args.primary),
    secondary: args.secondary ? makeItemResult(args.secondary) : undefined,
    primaryModel: 'serv-nano',
    secondaryModel: 'serv-swift',
    secondaryInvoked: Boolean(args.secondary),
    degradedMode: false,
    errors: [],
    totalLatencyMs: 10,
  } as any;
}

describe('ADR-0019 resolveActionAuthPromotion (pure)', () => {
  it('1. BLOCK + ALLOW (primary_block_rejected) → REVIEW / UNCERTAIN, never ALLOW', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'HOLD',
      cascadeReason: 'primary_block_rejected',
      mappedVerdict: 'UNCERTAIN',
      steps: allPass,
    });
    expect(d.publicVerdict).toBe('UNCERTAIN');
    expect(d.promoted).toBe(false);
    expect(d.reason).toBe('primary_block_disagreement');
    expect(d.trace.internal_verdict).toBe('HOLD');
    expect(d.trace.cascade_reason).toBe('primary_block_rejected');
    expect(d.trace.public_verdict).toBe('UNCERTAIN');
    expect(d.trace.steps_all_pass).toBe(true);
  });

  it('2. BLOCK + CONDITIONAL_ALLOW disagreement → REVIEW', () => {
    // Cascade encodes this as primary_block_rejected + HOLD as well.
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'HOLD',
      cascadeReason: 'primary_block_rejected',
      mappedVerdict: 'UNCERTAIN',
      steps: allPass,
      // secondary was CONDITIONAL_ALLOW — irrelevant once primary blocked
    });
    expect(d.publicVerdict).toBe('UNCERTAIN');
    expect(d.promoted).toBe(false);
    expect(d.reason).toBe('primary_block_disagreement');
  });

  it('3. agreement_conditional_allow without machine proof → REVIEW', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'CONDITIONAL_ALLOW',
      cascadeReason: 'agreement_conditional_allow',
      mappedVerdict: 'UNCERTAIN',
      steps: allPass,
      machineConditionProof: null,
    });
    expect(canPromoteAllStepsPass(allPass)).toBe(true);
    expect(d.publicVerdict).toBe('UNCERTAIN');
    expect(d.promoted).toBe(false);
    expect(d.reason).toBe('conditional_allow_no_machine_proof');
    expect(d.trace.machine_condition_proof_accepted).toBe(false);
  });

  it('4. agreement_allow → ALLOW unchanged', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
    });
    expect(d.publicVerdict).toBe('ALLOW');
    expect(d.promoted).toBe(false);
    expect(d.reason).toBe('already_allow');
  });

  it('5. non-action_authorization modes are pass-through (DQL/other lanes untouched)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'handoff',
      internalVerdict: 'CONDITIONAL_ALLOW',
      cascadeReason: 'agreement_conditional_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
    });
    expect(d.publicVerdict).toBe('ALLOW');
    expect(d.reason).toBe('not_action_authorization');
    expect(d.promoted).toBe(false);
  });

  it('ordering: internal CONDITIONAL_ALLOW cannot escape via mapped ALLOW passthrough', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'CONDITIONAL_ALLOW',
      cascadeReason: 'agreement_conditional_allow',
      mappedVerdict: 'ALLOW', // deliberate mis-map — must not become already_allow
      steps: allPass,
      machineConditionProof: null,
    });
    expect(d.publicVerdict).toBe('UNCERTAIN');
    expect(d.promoted).toBe(false);
    expect(d.reason).toBe('conditional_allow_no_machine_proof');
    expect(d.trace.internal_verdict).toBe('CONDITIONAL_ALLOW');
    expect(d.trace.mapped_verdict).toBe('ALLOW');
    expect(d.trace.public_verdict).toBe('UNCERTAIN');
  });

  it('6. No LLM text / fake proof object can activate the proof exception', () => {
    expect(acceptsMachineConditionProof(null)).toBe(false);
    expect(acceptsMachineConditionProof(undefined)).toBe(false);
    expect(
      acceptsMachineConditionProof({
        kind: 'llm_said_ok',
        fulfilled: true,
      }),
    ).toBe(false);
    expect(
      acceptsMachineConditionProof({
        kind: 'conditions_met',
        fulfilled: true,
        prose: 'All conditions satisfied per secondary model',
      } as any),
    ).toBe(false);
    expect(acceptsMachineConditionProof('conditions fulfilled' as any)).toBe(false);
    expect(acceptsMachineConditionProof(true as any)).toBe(false);

    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'CONDITIONAL_ALLOW',
      cascadeReason: 'agreement_conditional_allow',
      mappedVerdict: 'UNCERTAIN',
      steps: allPass,
      machineConditionProof: {
        kind: 'llm_said_ok',
        fulfilled: true,
      },
    });
    expect(d.publicVerdict).toBe('UNCERTAIN');
    expect(d.promoted).toBe(false);
    expect(d.reason).toBe('conditional_allow_no_machine_proof');
    expect(d.trace.machine_condition_proof_present).toBe(true);
    expect(d.trace.machine_condition_proof_accepted).toBe(false);
  });
});

describe('ADR-0019 engine wiring (action_authorization only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseReq: SentinelVerifyRequest = {
    claim: 'Proposed action: do X\nAgent reasoning: because Y',
    evidence: 'Mandate: only Z\nContext: c\nEvidence:\n- src: obs',
    mode: 'action_authorization',
    tier: 'standard',
  };

  it('engine: primary_block_rejected + all steps pass → UNCERTAIN + promotion trace', async () => {
    mockRunCascade.mockResolvedValueOnce(
      cascadeStub({
        verdict: 'HOLD',
        reason: 'primary_block_rejected',
        primary: 'BLOCK',
        secondary: 'ALLOW',
      }),
    );

    const res = await verify(baseReq);
    expect(res.verdict).toBe('UNCERTAIN');
    expect(res.meta.promotion).toBeDefined();
    expect(res.meta.promotion?.cascade_reason).toBe('primary_block_rejected');
    expect(res.meta.promotion?.internal_verdict).toBe('HOLD');
    expect(res.meta.promotion?.public_verdict).toBe('UNCERTAIN');
    expect(res.meta.promotion?.promoted).toBe(false);
    expect(res.meta.promotion?.reason).toBe('primary_block_disagreement');
    expect(res.meta.promotion?.steps_all_pass).toBe(true);
  });

  it('engine: agreement_conditional_allow + all steps pass → UNCERTAIN (no promote)', async () => {
    mockRunCascade.mockResolvedValueOnce(
      cascadeStub({
        verdict: 'CONDITIONAL_ALLOW',
        reason: 'agreement_conditional_allow',
        primary: 'CONDITIONAL_ALLOW',
        secondary: 'ALLOW',
      }),
    );

    const res = await verify(baseReq);
    expect(res.verdict).toBe('UNCERTAIN');
    expect(res.meta.promotion?.reason).toBe('conditional_allow_no_machine_proof');
    expect(res.meta.promotion?.promoted).toBe(false);
    expect(res.meta.promotion?.cascade_reason).toBe('agreement_conditional_allow');
    expect(res.meta.promotion?.internal_verdict).toBe('CONDITIONAL_ALLOW');
    expect(res.meta.promotion?.public_verdict).toBe('UNCERTAIN');
  });

  it('engine: agreement_allow → ALLOW unchanged', async () => {
    mockRunCascade.mockResolvedValueOnce(
      cascadeStub({
        verdict: 'ALLOW',
        reason: 'agreement_allow',
        primary: 'ALLOW',
        secondary: 'ALLOW',
      }),
    );

    const res = await verify(baseReq);
    expect(res.verdict).toBe('ALLOW');
    expect(res.meta.promotion?.reason).toBe('already_allow');
    expect(res.meta.promotion?.promoted).toBe(false);
    expect(res.meta.promotion?.public_verdict).toBe('ALLOW');
  });

  it('engine: non-action_authorization mode has no promotion meta and keeps prior mapping', async () => {
    mockRunCascade.mockResolvedValueOnce(
      cascadeStub({
        verdict: 'CONDITIONAL_ALLOW',
        reason: 'agreement_conditional_allow',
        primary: 'CONDITIONAL_ALLOW',
        secondary: 'ALLOW',
      }),
    );

    const res = await verify({
      claim: 'c',
      evidence: 'e',
      mode: 'handoff',
      tier: 'standard',
    });
    // handoff is non-conservative → CONDITIONAL_ALLOW maps to ALLOW
    expect(res.verdict).toBe('ALLOW');
    expect(res.meta.promotion).toBeUndefined();
  });
});
