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

  it('4b. agreement_allow + objective_mismatch → BLOCK (never already_allow)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: true,
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.promoted).toBe(false);
    expect(d.reason).toBe('objective_mismatch_fail_closed');
    expect(d.reason).not.toBe('already_allow');
  });

  it('4c. HOLD/UNCERTAIN + objective_mismatch → BLOCK (not weak REVIEW)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'HOLD',
      cascadeReason: 'agreement_hold',
      mappedVerdict: 'UNCERTAIN',
      steps: allPass,
      objectiveMismatch: true,
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.reason).toBe('objective_mismatch_fail_closed');
  });

  it('4d. agreement_allow + informational action + unknown mandate → BLOCK (allowlist)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'informational',
      mandateKind: 'unknown',
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.reason).toBe('objective_mismatch_fail_closed');
    expect(d.reason).not.toBe('already_allow');
  });

  it('4e2. agreement_allow + unknown action + deploy_ship → BLOCK (Fall 7c allowlist)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'unknown',
      mandateKind: 'deploy_ship',
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.reason).toBe('objective_mismatch_fail_closed');
    expect(d.reason).not.toBe('already_allow');
  });

  it('4e3. cascade BLOCK + unknown action + deploy_ship → objective_mismatch_fail_closed not already_block', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'BLOCK',
      cascadeReason: 'agreement_block',
      mappedVerdict: 'BLOCK',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'unknown',
      mandateKind: 'deploy_ship',
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.reason).toBe('objective_mismatch_fail_closed');
    expect(d.reason).not.toBe('already_block');
  });

  it('4e6. agreement_allow + unknown action + value_transfer → BLOCK named conflict', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'unknown',
      mandateKind: 'value_transfer',
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.reason).toBe('objective_mismatch_fail_closed');
  });

  it('4e5. agreement_allow + unknown/unknown → UNCERTAIN unclassified_abstention (not BLOCK)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'unknown',
      mandateKind: 'unknown',
    });
    expect(d.publicVerdict).toBe('UNCERTAIN');
    expect(d.publicVerdict).not.toBe('ALLOW');
    expect(d.publicVerdict).not.toBe('BLOCK');
    expect(d.reason).toBe('unclassified_abstention_fail_closed');
    expect(d.reason).not.toBe('objective_mismatch_fail_closed');
    expect(d.reason).not.toBe('already_allow');
  });

  it('4e7. agreement_allow + deploy_ship action + unknown mandate → BLOCK (#49)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'deploy_ship',
      mandateKind: 'unknown',
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.publicVerdict).not.toBe('ALLOW');
    expect(d.reason).toBe('objective_mismatch_fail_closed');
    expect(d.reason).not.toBe('already_allow');
    expect(d.reason).not.toBe('unclassified_abstention_fail_closed');
  });

  it('4e8. agreement_allow + deploy_ship + informational mandate → BLOCK (mismatch)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'deploy_ship',
      mandateKind: 'informational',
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.reason).toBe('objective_mismatch_fail_closed');
    expect(d.reason).not.toBe('already_allow');
  });

  it('4e10. agreement_allow + value_transfer action + unknown mandate → BLOCK (#53)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'value_transfer',
      mandateKind: 'unknown',
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.publicVerdict).not.toBe('ALLOW');
    expect(d.reason).toBe('objective_mismatch_fail_closed');
    expect(d.reason).not.toBe('already_allow');
  });

  it('4e11. agreement_allow + value_transfer + deploy_ship → BLOCK (prod sent_8d3b27d9bda0475e)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'value_transfer',
      mandateKind: 'deploy_ship',
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.reason).toBe('objective_mismatch_fail_closed');
    expect(d.reason).not.toBe('already_allow');
  });

  it('4e12. agreement_allow + permission action + unknown mandate → BLOCK (#53)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'permission',
      mandateKind: 'unknown',
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.reason).toBe('objective_mismatch_fail_closed');
    expect(d.reason).not.toBe('already_allow');
  });

  it('4e13. agreement_allow + permission + deploy_ship → BLOCK (mismatched pair)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'permission',
      mandateKind: 'deploy_ship',
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.reason).toBe('objective_mismatch_fail_closed');
    expect(d.reason).not.toBe('already_allow');
  });

  it('4e19. cascade BLOCK stays already_block (no ALLOW upgrade)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'BLOCK',
      cascadeReason: 'agreement_block',
      mappedVerdict: 'BLOCK',
      steps: allPass,
      actionKind: 'value_transfer',
      mandateKind: 'value_transfer',
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.reason).toBe('already_block');
    expect(d.publicVerdict).not.toBe('ALLOW');
  });

  it('4e14. agreement_allow + value_transfer + value_transfer stays already_allow', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'value_transfer',
      mandateKind: 'value_transfer',
    });
    expect(d.publicVerdict).toBe('ALLOW');
    expect(d.reason).toBe('already_allow');
  });

  it('4e16. agreement_allow + permission + value_transfer without bounded proof → BLOCK', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'permission',
      mandateKind: 'value_transfer',
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.reason).toBe('objective_mismatch_fail_closed');
    expect(d.reason).not.toBe('already_allow');
  });

  it('4e17. agreement_allow + permission + value_transfer + bounded compatible stays already_allow (ok-01)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'permission',
      mandateKind: 'value_transfer',
      boundedPermissionCompatible: true,
    });
    expect(d.publicVerdict).toBe('ALLOW');
    expect(d.reason).toBe('already_allow');
  });

  it('4e18. agreement_allow + permission + value_transfer + unbounded → BLOCK (MaxUint256 decimal)', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'permission',
      mandateKind: 'value_transfer',
      boundedPermissionCompatible: false,
    });
    expect(d.publicVerdict).toBe('BLOCK');
    expect(d.reason).toBe('objective_mismatch_fail_closed');
    expect(d.reason).not.toBe('already_allow');
  });

  it('4e15. agreement_allow + permission + permission stays already_allow', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'permission',
      mandateKind: 'permission',
    });
    expect(d.publicVerdict).toBe('ALLOW');
    expect(d.reason).toBe('already_allow');
  });

  it('4e9. agreement_allow + deploy_ship + deploy_ship stays already_allow', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'deploy_ship',
      mandateKind: 'deploy_ship',
    });
    expect(d.publicVerdict).toBe('ALLOW');
    expect(d.reason).toBe('already_allow');
  });

  it('4e4. agreement_allow + unknown action + informational mandate stays already_allow', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'unknown',
      mandateKind: 'informational',
    });
    expect(d.publicVerdict).toBe('ALLOW');
    expect(d.reason).toBe('already_allow');
  });

  it('4e. agreement_allow + positively informational mandate stays already_allow', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
      objectiveMismatch: false,
      actionKind: 'informational',
      mandateKind: 'informational',
    });
    expect(d.publicVerdict).toBe('ALLOW');
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

  // FYI-aligned so the #47 unknown-action fail-closed gate does not
  // swallow promotion-layer cases (those are tested separately).
  const baseReq: SentinelVerifyRequest = {
    claim: 'Tell CoS host runs git main',
    evidence:
      'USER INSTRUCTION: Tell CoS host runs git main\n' +
      'AGENT PROPOSED ACTION: Tell CoS host runs git main\n' +
      'AGENT REASONING: FYI only; no spend, no deploy.',
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
