import { describe, it, expect } from 'vitest';
import {
  mapVerdict,
  canPromoteStep2Only,
  canPromoteAllStepsPass,
  resolveActionAuthPromotion,
  acceptsMachineConditionProof,
  type StepLite,
} from './verdict.js';

// ── mapVerdict: action_authorization is conservative ──
describe('mapVerdict — action_authorization conservatism', () => {
  it('maps CONDITIONAL_ALLOW → UNCERTAIN in action_authorization (conservative)', () => {
    expect(mapVerdict('CONDITIONAL_ALLOW', 'action_authorization')).toBe('UNCERTAIN');
  });
  it('passes BLOCK through unchanged in action_authorization', () => {
    expect(mapVerdict('BLOCK', 'action_authorization')).toBe('BLOCK');
  });
  it('passes ALLOW through unchanged in action_authorization', () => {
    expect(mapVerdict('ALLOW', 'action_authorization')).toBe('ALLOW');
  });
});

// ── canPromoteAllStepsPass: the all-steps-pass → ALLOW guard (ADR-0019) ──
describe('canPromoteAllStepsPass', () => {
  const passing = (id: string): StepLite => ({ step_id: id, score: 0.85, predicate: 'faithful' });
  const weak = (id: string): StepLite => ({ step_id: id, score: 0.5, predicate: 'weakly_faithful' });

  it('promotes when ALL four authority steps pass', () => {
    expect(
      canPromoteAllStepsPass([passing('step_0'), passing('step_1'), passing('step_2'), passing('step_3')]),
    ).toBe(true);
  });

  it('does NOT promote when any single step is weak (a drain case always fails ≥1)', () => {
    expect(
      canPromoteAllStepsPass([passing('step_0'), passing('step_1'), passing('step_2'), weak('step_3')]),
    ).toBe(false);
  });

  it('does NOT promote when the scope step (step_0) fails — the unlimited-approval vector', () => {
    expect(
      canPromoteAllStepsPass([weak('step_0'), passing('step_1'), passing('step_2'), passing('step_3')]),
    ).toBe(false);
  });

  it('does NOT promote when the recipient step (step_1) fails — the injected-recipient vector', () => {
    expect(
      canPromoteAllStepsPass([passing('step_0'), weak('step_1'), passing('step_2'), passing('step_3')]),
    ).toBe(false);
  });

  it('does NOT promote on empty steps', () => {
    expect(canPromoteAllStepsPass([])).toBe(false);
  });

  it('treats a step at the SUPPORTED bar (0.5625) as passing', () => {
    const atBar: StepLite = { step_id: 'step_3', score: 0.5625, predicate: 'partially_faithful' };
    expect(
      canPromoteAllStepsPass([passing('step_0'), passing('step_1'), passing('step_2'), atBar]),
    ).toBe(true);
  });
});

// ── resolveActionAuthPromotion: 2026-08-08 addendum ──
describe('resolveActionAuthPromotion addendum', () => {
  const allPass: StepLite[] = [
    { step_id: 'step_0', score: 0.9, predicate: 'faithful' },
    { step_id: 'step_1', score: 0.9, predicate: 'faithful' },
    { step_id: 'step_2', score: 0.9, predicate: 'faithful' },
    { step_id: 'step_3', score: 0.9, predicate: 'faithful' },
  ];

  it('does not promote primary_block_rejected even when all steps pass', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'HOLD',
      cascadeReason: 'primary_block_rejected',
      mappedVerdict: 'UNCERTAIN',
      steps: allPass,
    });
    expect(d.publicVerdict).toBe('UNCERTAIN');
    expect(d.promoted).toBe(false);
  });

  it('does not promote agreement_conditional_allow without machine proof', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'CONDITIONAL_ALLOW',
      cascadeReason: 'agreement_conditional_allow',
      mappedVerdict: 'UNCERTAIN',
      steps: allPass,
    });
    expect(d.publicVerdict).toBe('UNCERTAIN');
    expect(d.reason).toBe('conditional_allow_no_machine_proof');
  });

  it('leaves agreement_allow as ALLOW', () => {
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'ALLOW',
      cascadeReason: 'agreement_allow',
      mappedVerdict: 'ALLOW',
      steps: allPass,
    });
    expect(d.publicVerdict).toBe('ALLOW');
  });

  it('acceptsMachineConditionProof is fail-closed', () => {
    expect(acceptsMachineConditionProof({ kind: 'x', fulfilled: true })).toBe(false);
  });

  it('internal CONDITIONAL_ALLOW cannot escape via mapped ALLOW passthrough', () => {
    // Ordering invariant: CONDITIONAL_ALLOW is gated before already_allow.
    // Even if mapVerdict were wrong and emitted ALLOW, public must stay REVIEW.
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'CONDITIONAL_ALLOW',
      cascadeReason: 'agreement_conditional_allow',
      mappedVerdict: 'ALLOW', // deliberate mis-map
      steps: allPass,
      machineConditionProof: null,
    });
    expect(d.publicVerdict).toBe('UNCERTAIN');
    expect(d.promoted).toBe(false);
    expect(d.reason).toBe('conditional_allow_no_machine_proof');
    expect(d.reason).not.toBe('already_allow');
  });

  it('does not use free-string primary_block substring matching', () => {
    // Unknown reason with primary_block in the name is NOT in the exact set.
    // Without set membership, HOLD stays UNCERTAIN via no_promote_path — not substring.
    const d = resolveActionAuthPromotion({
      mode: 'action_authorization',
      internalVerdict: 'HOLD',
      cascadeReason: 'something_primary_block_ish',
      mappedVerdict: 'UNCERTAIN',
      steps: allPass,
    });
    expect(d.publicVerdict).toBe('UNCERTAIN');
    expect(d.reason).not.toBe('primary_block_disagreement');
    expect(d.reason).toBe('no_promote_path');
  });
});

// ── mapVerdict: trade_reasoning is conservative like trade_execution ──
describe('mapVerdict — trade_reasoning conservatism', () => {
  it('maps CONDITIONAL_ALLOW → UNCERTAIN in trade_reasoning (conservative)', () => {
    expect(mapVerdict('CONDITIONAL_ALLOW', 'trade_reasoning')).toBe('UNCERTAIN');
  });
  it('maps CONDITIONAL_ALLOW → UNCERTAIN in trade_execution (unchanged)', () => {
    expect(mapVerdict('CONDITIONAL_ALLOW', 'trade_execution')).toBe('UNCERTAIN');
  });
  it('maps CONDITIONAL_ALLOW → ALLOW in a non-conservative mode (handoff)', () => {
    expect(mapVerdict('CONDITIONAL_ALLOW', 'handoff')).toBe('ALLOW');
  });
  it('passes BLOCK through unchanged in trade_reasoning', () => {
    expect(mapVerdict('BLOCK', 'trade_reasoning')).toBe('BLOCK');
  });
  it('passes ALLOW through unchanged in trade_reasoning', () => {
    expect(mapVerdict('ALLOW', 'trade_reasoning')).toBe('ALLOW');
  });
});

// ── canPromoteStep2Only: the step_2-only → ALLOW guard (ADR-0018) ──
describe('canPromoteStep2Only', () => {
  const passing = (id: string): StepLite => ({ step_id: id, score: 0.85, predicate: 'faithful' });
  const weak = (id: string): StepLite => ({ step_id: id, score: 0.5, predicate: 'weakly_faithful' });

  it('promotes when step_0 + step_1 pass and only step_2 is weak', () => {
    expect(canPromoteStep2Only([passing('step_0'), passing('step_1'), weak('step_2')])).toBe(true);
  });

  it('does NOT promote when step_0 (a factual step) is weak', () => {
    expect(canPromoteStep2Only([weak('step_0'), passing('step_1'), weak('step_2')])).toBe(false);
  });

  it('does NOT promote when step_1 (direction) is weak', () => {
    expect(canPromoteStep2Only([passing('step_0'), weak('step_1'), weak('step_2')])).toBe(false);
  });

  it('does NOT promote when both factual steps are weak', () => {
    expect(canPromoteStep2Only([weak('step_0'), weak('step_1'), weak('step_2')])).toBe(false);
  });

  it('does NOT promote when step_2 itself actually passes (nothing to promote)', () => {
    expect(canPromoteStep2Only([passing('step_0'), passing('step_1'), passing('step_2')])).toBe(false);
  });

  it('does NOT promote when a factual step is missing', () => {
    expect(canPromoteStep2Only([passing('step_0'), weak('step_2')])).toBe(false);
  });

  it('does NOT promote on empty steps', () => {
    expect(canPromoteStep2Only([])).toBe(false);
  });

  it('treats score ≥ 0.5625 as passing even with a non-faithful predicate', () => {
    // A factual step at the SUPPORTED bar should count as passing.
    const atBar: StepLite = { step_id: 'step_0', score: 0.5625, predicate: 'partially_faithful' };
    expect(canPromoteStep2Only([atBar, passing('step_1'), weak('step_2')])).toBe(true);
  });

  it('treats score just below 0.5625 on a factual step as failing → no promote', () => {
    const belowBar: StepLite = { step_id: 'step_0', score: 0.56, predicate: 'partially_faithful' };
    expect(canPromoteStep2Only([belowBar, passing('step_1'), weak('step_2')])).toBe(false);
  });

  it('does not throw / promote on unexpected extra steps', () => {
    const steps = [passing('step_0'), passing('step_1'), weak('step_2'), weak('step_3')];
    // step_3 is ignored; promotion still keys only on 0/1 passing + 2 weak.
    expect(canPromoteStep2Only(steps)).toBe(true);
  });
});
