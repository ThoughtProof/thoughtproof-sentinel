import { describe, expect, it } from 'vitest';
import {
  faithfulnessPredicateFromScore,
  isNanoModel,
  normalizeNanoStep,
  normalizeNanoStepArray,
} from '../../vendor/pot-cli-0.8.13/nano-step-contract.js';

describe('nano step contract aliases', () => {
  it('reads reason as reasoning and recomputes predicate from the score', () => {
    const n = normalizeNanoStep({
      step_id: 'step_1',
      score: 1,
      verdict: 'pass',
      predicate: 'not-a-predicate',
      reason: 'The trace states an uptrend.',
    });
    expect(n.malformed).toBe(false);
    expect(n.step.reasoning).toBe('The trace states an uptrend.');
    expect(n.step.predicate).toBe('faithful');
    expect(n.step.predicate).not.toBe('not-a-predicate');
  });

  it('does not require predicate when the score is present', () => {
    const n = normalizeNanoStep({
      step_id: 'step_0',
      score: 0,
      verdict: 'fail',
      reason: 'No numerical threshold is cited.',
    });
    expect(n.malformed).toBe(false);
    expect(n.step.predicate).toBe('unfaithful');
  });

  it('rejects a string score instead of coercing it', () => {
    const n = normalizeNanoStep({ step_id: 'step_2', score: '0.5', reason: 'gap' });
    expect(n.malformed).toBe(true);
    expect(n.reason).toMatch(/\[0,1\]/);
  });

  it('keeps an omitted quote well-formed when reasoning is present', () => {
    const n = normalizeNanoStep({ step_id: 'step_1', score: 0.9, reason: 'cited' });
    expect(n.malformed).toBe(false);
    expect('quote' in n.step).toBe(false);
  });

  it('treats an explicit null quote plus reasoning as well-formed', () => {
    const n = normalizeNanoStep({
      step_id: 'step_1',
      score: 0.8,
      reason: 'no span',
      quote: null,
    });
    expect(n.malformed).toBe(false);
  });
});

describe('nano step contract malformed detection', () => {
  it('is malformed when the score is missing', () => {
    const n = normalizeNanoStep({ step_id: 'step_0', reason: 'text', quote: 'span' });
    expect(n.malformed).toBe(true);
    expect(n.reason).toMatch(/\[0,1\]/);
  });

  it('is malformed when both reasoning and quote are absent', () => {
    const n = normalizeNanoStep({ step_id: 'step_1', score: 1, verdict: 'pass' });
    expect(n.malformed).toBe(true);
    expect(n.reason).toMatch(/neither reasoning nor quote/);
  });

  it('is well-formed when a quote is present and reasoning is absent', () => {
    const n = normalizeNanoStep({ step_id: 'step_1', score: 1, quote: 'exact span from the trace' });
    expect(n.malformed).toBe(false);
    expect(n.step.predicate).toBe('faithful');
  });

  it('flags an empty array', () => {
    const n = normalizeNanoStepArray([]);
    expect(n.malformed).toBe(true);
  });
});

const EXPECTED = ['step_0', 'step_1', 'step_2'];

function complete(overrides: Record<string, unknown> = {}) {
  return EXPECTED.map((step_id) => ({
    step_id,
    score: 0.5,
    reason: `reason for ${step_id}`,
    quote: null,
    ...overrides,
  }));
}

describe('nano step contract completeness', () => {
  it('rejects a missing step', () => {
    const steps = complete().filter((s) => s.step_id !== 'step_2');
    const n = normalizeNanoStepArray(steps, EXPECTED);
    expect(n.malformed).toBe(true);
    expect(n.reasons.join(' ')).toMatch(/step_2 is missing/);
  });

  it('rejects duplicate ids', () => {
    const steps = complete();
    steps.push({ step_id: 'step_0', score: 0.2, reason: 'again', quote: null });
    const n = normalizeNanoStepArray(steps, EXPECTED);
    expect(n.malformed).toBe(true);
    expect(n.reasons.join(' ')).toMatch(/step_0 is duplicated/);
  });

  it('rejects an unexpected id', () => {
    const steps = [...complete(), { step_id: 'step_9', score: 0.2, reason: 'extra', quote: null }];
    const n = normalizeNanoStepArray(steps, EXPECTED);
    expect(n.malformed).toBe(true);
    expect(n.reasons.join(' ')).toMatch(/step_9 is not an expected step/);
  });

  it.each([
    ['below zero', -0.1],
    ['above one', 1.5],
    ['NaN', Number.NaN],
  ])('rejects a score that is %s', (_label, score) => {
    const steps = complete();
    steps[1] = { ...steps[1], score };
    const n = normalizeNanoStepArray(steps, EXPECTED);
    expect(n.malformed).toBe(true);
    expect(n.reasons.join(' ')).toMatch(/step_1 score is not a finite number in \[0,1\]/);
  });

  it('rejects a string score on an otherwise complete list', () => {
    const steps = complete();
    steps[0] = { ...steps[0], score: '1' as unknown as number };
    const n = normalizeNanoStepArray(steps, EXPECTED);
    expect(n.malformed).toBe(true);
    expect(n.reasons.join(' ')).toMatch(/step_0 score is not a finite number in \[0,1\]/);
  });

  it('accepts a complete unique list with scores in range', () => {
    const n = normalizeNanoStepArray(complete(), EXPECTED);
    expect(n.malformed).toBe(false);
    expect(n.steps.map((s) => s.predicate)).toEqual([
      faithfulnessPredicateFromScore(0.5),
      faithfulnessPredicateFromScore(0.5),
      faithfulnessPredicateFromScore(0.5),
    ]);
  });
});

describe('isNanoModel', () => {
  it('matches serv-nano and not serv-swift or grok', () => {
    expect(isNanoModel('serv-nano')).toBe(true);
    expect(isNanoModel('serv-swift')).toBe(false);
    expect(isNanoModel('grok-4.3')).toBe(false);
  });
});
