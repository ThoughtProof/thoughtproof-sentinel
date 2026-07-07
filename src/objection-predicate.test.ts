import { describe, it, expect } from 'vitest';
import {
  predicateFromFlag,
  satisfiesPredicate,
  enforcementLevel,
  measureRevisedValue,
  checkRevision,
  type VerifiedFactFlag,
  type ObjectionPredicate,
  type VerifiedMarketFacts,
  type MeasuredValue,
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

    it('fails CLOSED (false, never a third state) on NaN/Infinity/undefined/null', () => {
      // The whole value of the approach is that malformed input can never
      // produce UNCERTAIN — it must resolve to a strict boolean (and, being
      // fail-closed, to `false` = "objection not satisfied").
      const pred = predicateFromFlag({
        kind: 'magnitude', claimedValue: 186, actualValue: 41, evidenceLine: 'x',
      });
      for (const bad of [NaN, Infinity, -Infinity, undefined, null]) {
        const r = satisfiesPredicate(pred, bad as unknown as number);
        expect(typeof r).toBe('boolean');
        expect(r).toBe(false); // fail-closed
      }
    });

    it('direction: Math.sign(0) → flat is distinct from up/down', () => {
      // A verified flat market (actualValue 0) must NOT be satisfied by a
      // revision claiming up (+1) or down (-1).
      const pred = predicateFromFlag({
        kind: 'direction', claimedValue: 1, actualValue: 0, evidenceLine: 'x',
      });
      expect(pred.value).toBe(0);
      expect(satisfiesPredicate(pred, 0)).toBe(true);
      expect(satisfiesPredicate(pred, 1)).toBe(false);
      expect(satisfiesPredicate(pred, -1)).toBe(false);
    });

    it('missing tolerancePp collapses approx to exact-match (documented, strict)', () => {
      const pred = { kind: 'magnitude', field: 'move_pct', op: 'approx',
        value: 41, claimedValue: 186, actualValue: 41 } as ObjectionPredicate;
      expect(satisfiesPredicate(pred, 41)).toBe(true);
      expect(satisfiesPredicate(pred, 41.5)).toBe(false); // no tolerance → strict
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

  // ── VERIFIED-REVISION MEASUREMENT: the "given a measured value" clause enforced. ──
  describe('measureRevisedValue draws from the snapshot, not agent text', () => {
    const facts: VerifiedMarketFacts = {
      priceChangePct24h: 44.0, change7dPct: 41.0,
      price: 0.0089, low24h: 0.006, high24h: 0.010,
    };
    it('magnitude: measures the nearest verified move, ignores any agent claim', () => {
      const pred = predicateFromFlag({ kind: 'magnitude', claimedValue: 186, actualValue: 41, evidenceLine: 'x' });
      const m = measureRevisedValue(pred, facts);
      expect(m.source).toBe('fact-checker');       // provenance stamped
      expect(m.field).toBe('move_pct');
      // nearest of |44|,|41| to predicate.value 41 → 41 (not any agent-claimed number)
      expect(m.value).toBe(41);
    });
    it('direction: measures trend sign from change7dPct', () => {
      const pred = predicateFromFlag({ kind: 'direction', claimedValue: 1, actualValue: -6.2, evidenceLine: 'x' });
      const m = measureRevisedValue(pred, { ...facts, change7dPct: -6.2 });
      expect(m.value).toBe(-1);
    });
    it('range_pct: computes position from price/low/high, degenerate range → NaN (fail-closed)', () => {
      const pred = predicateFromFlag({ kind: 'range_position', claimedValue: 90, actualValue: 55, evidenceLine: 'x' });
      const m = measureRevisedValue(pred, { ...facts, low24h: 0.01, high24h: 0.01 });
      expect(Number.isNaN(m.value)).toBe(true);
    });
  });

  describe('checkRevision enforces provenance — agent-asserted numbers cannot pass', () => {
    const pred = predicateFromFlag({ kind: 'magnitude', claimedValue: 186, actualValue: 41, evidenceLine: 'x' });

    it('accepts a fact-checker-measured value and applies the boolean gate', () => {
      const measured: MeasuredValue = { value: 44, source: 'fact-checker', field: 'move_pct' };
      const r = checkRevision(pred, measured);
      expect(r.satisfied).toBe(true); // |44-41| <= 10
    });
    it('fails closed when the value did not come from the fact-checker', () => {
      // Simulate an agent-asserted value that lies about its source.
      const spoofed = { value: 41, source: 'agent' as any, field: 'move_pct' } as MeasuredValue;
      const r = checkRevision(pred, spoofed);
      expect(r.satisfied).toBe(false);
      expect(r.reason).toMatch(/not fact-checker-measured/);
    });
    it('fails closed on field mismatch (predicate vs measured value)', () => {
      const wrongField: MeasuredValue = { value: 0, source: 'fact-checker', field: 'trend_sign' };
      const r = checkRevision(pred, wrongField);
      expect(r.satisfied).toBe(false);
      expect(r.reason).toMatch(/field mismatch/);
    });
    it('end-to-end: measure from snapshot then gate — the whole "given" clause', () => {
      const facts: VerifiedMarketFacts = {
        priceChangePct24h: 44, change7dPct: 41, price: 0.0089, low24h: 0.006, high24h: 0.010,
      };
      const measured = measureRevisedValue(pred, facts);
      const r = checkRevision(pred, measured);
      expect(measured.source).toBe('fact-checker');
      expect(r.satisfied).toBe(true);
    });
  });
});
