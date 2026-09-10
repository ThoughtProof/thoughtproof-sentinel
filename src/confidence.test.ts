import { describe, expect, it } from 'vitest';
import {
  clampUnitConfidence,
  confidenceToPercent,
  finiteScore,
  receiptConfidence,
} from './confidence.js';

describe('finiteScore (issue #39)', () => {
  it('passes finite numbers through', () => {
    expect(finiteScore(0)).toBe(0);
    expect(finiteScore(0.87)).toBe(0.87);
    expect(finiteScore(1)).toBe(1);
  });

  it('coerces missing / non-finite scores to 0', () => {
    expect(finiteScore(undefined)).toBe(0);
    expect(finiteScore(null)).toBe(0);
    expect(finiteScore(NaN)).toBe(0);
    expect(finiteScore(Infinity)).toBe(0);
    expect(finiteScore(-Infinity)).toBe(0);
    expect(finiteScore('0.9')).toBe(0);
  });
});

describe('clampUnitConfidence / receiptConfidence', () => {
  it('is always a finite number in [0, 1]', () => {
    for (const raw of [undefined, null, NaN, Infinity, -Infinity, -0.2, 0, 0.5, 1, 1.4, 'x']) {
      const c = clampUnitConfidence(raw);
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
      const json = JSON.parse(JSON.stringify({ confidence: c })) as { confidence: unknown };
      expect(json.confidence).not.toBeNull();
      expect(typeof json.confidence).toBe('number');
    }
  });

  it('rounds receipt confidence to 3 decimal places', () => {
    expect(receiptConfidence(0.87654321)).toBe(0.877);
  });
});

describe('confidenceToPercent (attestation / canonical copy)', () => {
  it('maps unit confidence to 0–100 int', () => {
    expect(confidenceToPercent(0.875)).toBe(88);
    expect(confidenceToPercent(0.84)).toBe(84);
    expect(confidenceToPercent(1)).toBe(100);
  });

  it('never emits NaN for non-finite source confidence', () => {
    expect(confidenceToPercent(NaN)).toBe(0);
    expect(confidenceToPercent(undefined)).toBe(0);
    expect(confidenceToPercent(Infinity)).toBe(0);
    expect(Number.isFinite(confidenceToPercent(NaN))).toBe(true);
  });
});
