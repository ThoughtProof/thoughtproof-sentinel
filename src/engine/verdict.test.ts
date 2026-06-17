import { describe, it, expect } from 'vitest';
import { mapVerdict, canPromoteStep2Only, type StepLite } from './verdict.js';

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
