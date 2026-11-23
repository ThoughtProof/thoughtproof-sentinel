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

  it('accepts a numeric-string score', () => {
    const n = normalizeNanoStep({ step_id: 'step_2', score: '0.5', reason: 'gap' });
    expect(n.malformed).toBe(false);
    expect(n.step.score).toBe(0.5);
    expect(n.step.predicate).toBe(faithfulnessPredicateFromScore(0.5));
    expect(n.step.predicate).toBe('weakly_faithful');
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
    expect(n.reason).toMatch(/no numeric score/);
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

describe('isNanoModel', () => {
  it('matches serv-nano and not serv-swift or grok', () => {
    expect(isNanoModel('serv-nano')).toBe(true);
    expect(isNanoModel('serv-swift')).toBe(false);
    expect(isNanoModel('grok-4.3')).toBe(false);
  });
});
