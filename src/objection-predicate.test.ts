import { describe, it, expect } from 'vitest';
import {
  predicateFromFlag,
  satisfiesPredicate,
  enforcementLevel,
  type VerifiedFactFlag,
} from './objection-predicate.js';

describe('objection-predicate — numeric-class binding (Federico design)', () => {
  // ── The core property: the gate is a boolean, it CANNOT return UNCERTAIN. ──
  describe('satisfiesPredicate returns a strict boolean (never a third state)', () => {
    it('magnitude: revised move within tolerance of verified → true', () => {
      // hold: thesis claimed +21.8%, verified move was +8.1% (flagged)
      const flag: VerifiedFactFlag = {
        kind: 'magnitude', claimText: '~21.8% rally',
        claimedValue: 21.8, actualValue: 8.1,
        evidenceLine: 'structural_fact: verified move ≈ +8.1%; thesis claims ~21.8%',
      };
      const pred = predicateFromFlag(flag);
      // revised thesis now claims a move near the verified 8.1% → responsive
      expect(satisfiesPredicate(pred, 9.0)).toBe(true);   // |9.0-8.1|=0.9 ≤ 10
      // revised STILL overstates far beyond tolerance → not responsive
      expect(satisfiesPredicate(pred, 21.0)).toBe(false); // |21-8.1|=12.9 > 10
    });

    it('direction: revised asserts the verified sign → true; still opposite → false', () => {
      // hold: thesis claimed "up" (bullish), verified trend was -6.2% (down)
      const flag: VerifiedFactFlag = {
        kind: 'direction', claimedValue: 1, actualValue: -6.2,
        evidenceLine: 'structural_fact: window trend -6.2% (down); thesis claims uptrend',
      };
      const pred = predicateFromFlag(flag);
      expect(pred.value).toBe(-1);                       // verified sign = down
      expect(satisfiesPredicate(pred, -1)).toBe(true);   // revised now bearish → responsive
      expect(satisfiesPredicate(pred, 1)).toBe(false);   // revised still bullish → not
      expect(satisfiesPredicate(pred, 0)).toBe(false);   // flat ≠ verified down → not
    });

    it('range_position: within 15pp tolerance boundary', () => {
      const flag: VerifiedFactFlag = {
        kind: 'range_position', claimedValue: 90, actualValue: 55,
        evidenceLine: 'structural_fact: verified range position = 55%; thesis claims "near highs" (90%)',
      };
      const pred = predicateFromFlag(flag);
      expect(satisfiesPredicate(pred, 60)).toBe(true);   // |60-55|=5 ≤ 15
      expect(satisfiesPredicate(pred, 85)).toBe(false);  // |85-55|=30 > 15
    });

    it('every op path yields exactly true or false — no undefined/null leak', () => {
      const flag: VerifiedFactFlag = {
        kind: 'magnitude', claimedValue: 20, actualValue: 5,
        evidenceLine: 'x',
      };
      const pred = predicateFromFlag(flag);
      for (const v of [-100, 0, 5, 5.0001, 15, 15.1, 1e9]) {
        const r = satisfiesPredicate(pred, v);
        expect(typeof r).toBe('boolean'); // the anti-degeneration guarantee
      }
    });
  });

  // ── The honest boundary: numeric classes are gated, fuzzy ones are not. ──
  describe('enforcementLevel marks the per-objection boundary', () => {
    it('the three numeric classes are predicate-gated', () => {
      expect(enforcementLevel('direction')).toBe('predicate-gated');
      expect(enforcementLevel('magnitude')).toBe('predicate-gated');
      expect(enforcementLevel('range_position')).toBe('predicate-gated');
    });
    it('the fuzzy classes are fresh-judgment-only', () => {
      expect(enforcementLevel('inferential_integrity')).toBe('fresh-judgment-only');
      expect(enforcementLevel('self_contradiction')).toBe('fresh-judgment-only');
      expect(enforcementLevel('missing_evidence')).toBe('fresh-judgment-only');
      expect(enforcementLevel('anything_else')).toBe('fresh-judgment-only');
    });
  });

  // ── Provenance: the predicate carries the hold-time triple for auditability. ──
  it('predicate carries claimed vs actual for the anchored artifact', () => {
    const flag: VerifiedFactFlag = {
      kind: 'magnitude', claimedValue: 30, actualValue: 12,
      evidenceLine: 'x',
    };
    const pred = predicateFromFlag(flag);
    expect(pred.claimedValue).toBe(30);
    expect(pred.actualValue).toBe(12);
    expect(pred.field).toBe('move_pct');
    expect(pred.op).toBe('approx');
  });
});
