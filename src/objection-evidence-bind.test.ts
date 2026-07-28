/**
 * Objection evidence bind — unit tests.
 * Paris class: 583 ≤ 600 + "exceeds budget" → strip.
 */
import { describe, it, expect } from 'vitest';
import {
  boundTotals,
  parseNumericClaim,
  bindObjectionText,
  bindStepObjections,
} from './objection-evidence-bind.js';
import type { SentinelStepObjection } from './types.js';

describe('parseNumericClaim', () => {
  it('detects exceed relation', () => {
    const c = parseNumericClaim('Total exceeds budget ceiling.');
    expect(c.is_numericish).toBe(true);
    expect(c.relation).toBe('exceed');
  });

  it('detects within relation', () => {
    const c = parseNumericClaim('Amount is within budget of 600.');
    expect(c.is_numericish).toBe(true);
    expect(c.relation).toBe('within');
  });

  it('leaves non-numeric claims alone', () => {
    const c = parseNumericClaim('Counterparty mismatch on IBAN.');
    expect(c.is_numericish).toBe(false);
    expect(c.relation).toBeNull();
  });
});

describe('boundTotals', () => {
  it('reads mandate action amount + granted maxAmount', () => {
    const b = boundTotals({
      mandate: {
        granted: { maxAmount: 600 },
        action: { amount: 583 },
      },
    });
    expect(b.amount).toBe(583);
    expect(b.ceiling).toBe(600);
  });

  it('sums flight+hotel components from embedded evidence JSON', () => {
    const b = boundTotals({
      evidence: JSON.stringify({
        flight: 268,
        hotel: 315,
        budget_ceiling: 600,
      }),
    });
    expect(b.components.flight).toBe(268);
    expect(b.components.hotel).toBe(315);
    expect(b.amount).toBe(583);
    expect(b.ceiling).toBe(600);
  });
});

describe('bindObjectionText — Paris class', () => {
  const ctx = {
    mandate: {
      granted: { maxAmount: 600 },
      action: { amount: 583 },
    },
  };

  it('strips fabricated exceed when 583 <= 600', () => {
    const r = bindObjectionText('Total exceeds budget ceiling.', ctx);
    expect(r.status).toBe('objection_evidence_fail');
    expect(r.surface).toBe('strip_reason');
    expect(r.log_code).toBe('numeric_exceed_false');
    expect(r.safe_reason).toMatch(/objection_evidence_fail/);
    expect(r.detail).toMatchObject({
      computed_amount: 583,
      computed_ceiling: 600,
      actually_exceeds: false,
    });
  });

  it('passes true exceed through', () => {
    const r = bindObjectionText('Total exceeds budget ceiling.', {
      mandate: {
        granted: { maxAmount: 600 },
        action: { amount: 750 },
      },
    });
    expect(r.status).toBe('verified');
    expect(r.surface).toBe('pass_through');
    expect(r.log_code).toBe('numeric_exceed_true');
  });

  it('passes non-numeric through', () => {
    const r = bindObjectionText('Recipient not on allowlist.', ctx);
    expect(r.status).toBe('non_numeric');
    expect(r.surface).toBe('pass_through');
  });

  it('strips numericish without bounds (fail-closed on surface)', () => {
    const r = bindObjectionText('Total exceeds budget ceiling.', {
      claim: 'book trip',
      evidence: 'no numbers here',
    });
    expect(r.status).toBe('unverified_insufficient_bounds');
    expect(r.surface).toBe('strip_reason');
    expect(r.log_code).toBe('numeric_unverified');
  });
});

describe('bindStepObjections', () => {
  it('strips fabricated numeric reason, keeps non-numeric sibling', () => {
    const objs: SentinelStepObjection[] = [
      {
        step_id: 'step_0',
        criterion: 'budget check',
        score: 0.1,
        predicate: 'unsupported',
        quote: null,
        reasoning: 'Total exceeds budget ceiling.',
      },
      {
        step_id: 'step_1',
        criterion: 'recipient check',
        score: 0.2,
        predicate: 'unsupported',
        quote: null,
        reasoning: 'Recipient not on allowlist.',
      },
    ];
    const b = bindStepObjections(objs, {
      mandate: {
        granted: { maxAmount: 600 },
        action: { amount: 583 },
      },
    });
    expect(b.n_evidence_fail).toBe(1);
    expect(b.n_non_numeric).toBe(1);
    expect(b.surface_gated).toBe(true);
    expect(b.surface_objections).toHaveLength(2);
    expect(b.surface_objections[0].reasoning).toMatch(/objection_evidence_fail/);
    expect(b.surface_objections[1].reasoning).toBe('Recipient not on allowlist.');
    expect(b.codes).toContain('numeric_exceed_false');
  });

  it('does not change shape when nothing numeric', () => {
    const objs: SentinelStepObjection[] = [
      {
        step_id: 'step_0',
        criterion: 'x',
        score: 0.9,
        predicate: 'supported',
        quote: null,
        reasoning: 'Evidence supports the claim.',
      },
    ];
    const b = bindStepObjections(objs, { claim: 'x', evidence: 'y' });
    expect(b.surface_gated).toBe(false);
    expect(b.surface_objections[0].reasoning).toBe('Evidence supports the claim.');
  });
});
