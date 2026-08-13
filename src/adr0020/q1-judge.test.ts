import { describe, it, expect } from 'vitest';
import {
  evaluateQ1Eligibility,
  toQ1Verdict,
  countProofStats,
  Q1_JUDGE_VERSION,
} from './q1-judge.js';

function binding(eid: string, cond: string, overrides: Record<string, unknown> = {}) {
  return {
    evidence_id: eid,
    bound_condition_id: cond,
    syntactically_valid: true,
    freshness: 'fresh',
    contradicted: false,
    grade: 'machine',
    ...overrides,
  };
}

function baseEligible() {
  return {
    sentinel_verdict: 'REVIEW',
    reason_code: 'conditional_allow_no_machine_proof',
    required_conditions: [
      {
        condition_id: 'alpha_required',
        required: true,
        proof_requirement: 'machine',
        evidence_bindings: [binding('evidence:alpha_ok', 'alpha_required')],
      },
      {
        condition_id: 'beta_required',
        required: true,
        proof_requirement: 'machine',
        evidence_bindings: [] as ReturnType<typeof binding>[],
      },
    ],
  };
}

describe('ADR-0020 Q1 judge', () => {
  it('exports version id', () => {
    expect(Q1_JUDGE_VERSION).toBe('adr0020.q1.judge.v0.1');
  });

  it('maps UNCERTAIN → REVIEW for eligibility class', () => {
    expect(toQ1Verdict('UNCERTAIN')).toBe('REVIEW');
    expect(toQ1Verdict('ALLOW')).toBe('ALLOW');
  });

  it('triggers on multi-conjunct missing machine proof', () => {
    const d = evaluateQ1Eligibility(baseEligible());
    expect(d.eligible).toBe(true);
    expect(d.triggerCode).toBe('multi_conjunct_missing_machine_proof');
  });

  it('treats public UNCERTAIN as REVIEW', () => {
    const input = baseEligible();
    input.sentinel_verdict = 'UNCERTAIN';
    expect(evaluateQ1Eligibility(input).eligible).toBe(true);
  });

  it('rejects caller canonical override (ALLOW + canonical REVIEW)', () => {
    const d = evaluateQ1Eligibility({
      ...baseEligible(),
      sentinel_verdict: 'ALLOW',
      canonical_verdict: 'REVIEW',
    });
    expect(d.eligible).toBe(false);
    expect(d.triggerCode).toBe('invalid_input');
  });

  it('ignores case_id (redaction invariant)', () => {
    const a = { ...baseEligible(), case_id: 'S-IM-005' };
    const b = { ...baseEligible(), case_id: 'REDACTED' };
    const c = baseEligible();
    expect(evaluateQ1Eligibility(a)).toEqual(evaluateQ1Eligibility(b));
    expect(evaluateQ1Eligibility(b)).toEqual(evaluateQ1Eligibility(c));
  });

  it('does not escalate ALLOW/BLOCK', () => {
    expect(evaluateQ1Eligibility({ ...baseEligible(), sentinel_verdict: 'ALLOW' })).toEqual({
      eligible: false,
      triggerCode: 'not_review',
    });
    expect(evaluateQ1Eligibility({ ...baseEligible(), sentinel_verdict: 'BLOCK' })).toEqual({
      eligible: false,
      triggerCode: 'not_review',
    });
  });

  it('does not escalate wrong reason', () => {
    expect(
      evaluateQ1Eligibility({ ...baseEligible(), reason_code: 'primary_hold' }).triggerCode,
    ).toBe('reason_not_eligible');
  });

  it('single required → insufficient', () => {
    const input = baseEligible();
    input.required_conditions = [input.required_conditions[1]];
    expect(evaluateQ1Eligibility(input).triggerCode).toBe('insufficient_required_conditions');
  });

  it('duplicate condition_id → invalid_input (not multi-conjunct)', () => {
    const input = baseEligible();
    input.required_conditions = [
      {
        condition_id: 'same_id',
        required: true,
        proof_requirement: 'machine',
        evidence_bindings: [],
      },
      {
        condition_id: 'same_id',
        required: true,
        proof_requirement: 'machine',
        evidence_bindings: [],
      },
    ];
    expect(evaluateQ1Eligibility(input)).toEqual({
      eligible: false,
      triggerCode: 'invalid_input',
    });
  });

  it('optional missing does not create multi-conjunct alone', () => {
    const input = {
      sentinel_verdict: 'REVIEW',
      reason_code: 'conditional_allow_no_machine_proof',
      required_conditions: [
        {
          condition_id: 'only_one',
          required: true,
          proof_requirement: 'machine',
          evidence_bindings: [],
        },
        {
          condition_id: 'opt',
          required: false,
          proof_requirement: 'machine',
          evidence_bindings: [],
        },
      ],
    };
    expect(evaluateQ1Eligibility(input).triggerCode).toBe('insufficient_required_conditions');
  });

  it('stale/wrong-bind/contradicted do not count as valid', () => {
    const input = baseEligible();
    input.required_conditions[1].evidence_bindings = [
      binding('evidence:stale', 'beta_required', { freshness: 'stale' }),
    ];
    expect(evaluateQ1Eligibility(input).eligible).toBe(true);

    input.required_conditions[1].evidence_bindings = [
      binding('evidence:wrong', 'beta_required', { bound_condition_id: 'other' }),
    ];
    expect(evaluateQ1Eligibility(input).eligible).toBe(true);

    input.required_conditions[1].evidence_bindings = [
      binding('evidence:cx', 'beta_required', { contradicted: true }),
    ];
    expect(evaluateQ1Eligibility(input).eligible).toBe(true);
  });

  it('poisoned precomputed count without bindings does NOT prove bound', () => {
    // Even if a caller smuggles a count field on the object, judge ignores it.
    const input = {
      sentinel_verdict: 'REVIEW',
      reason_code: 'conditional_allow_no_machine_proof',
      required_conditions: [
        {
          condition_id: 'alpha_required',
          required: true,
          proof_requirement: 'machine',
          evidence_bindings: [binding('evidence:alpha_ok', 'alpha_required')],
        },
        {
          condition_id: 'beta_required',
          required: true,
          proof_requirement: 'machine',
          // no bindings array — count must be 0, not trusted precompute
          valid_bound_evidence_count: 99,
        },
      ],
    };
    const d = evaluateQ1Eligibility(input);
    expect(d.eligible).toBe(true);
    expect(d.triggerCode).toBe('multi_conjunct_missing_machine_proof');
  });

  it('missing bindings array counts as unproven (not invalid)', () => {
    const input = {
      sentinel_verdict: 'REVIEW',
      reason_code: 'conditional_allow_no_machine_proof',
      required_conditions: [
        {
          condition_id: 'a',
          required: true,
          proof_requirement: 'machine',
        },
        {
          condition_id: 'b',
          required: true,
          proof_requirement: 'machine',
        },
      ],
    };
    expect(evaluateQ1Eligibility(input).eligible).toBe(true);
  });

  it('filling missing proof drops trigger', () => {
    const input = baseEligible();
    input.required_conditions[1].evidence_bindings = [
      binding('evidence:beta_ok', 'beta_required'),
    ];
    expect(evaluateQ1Eligibility(input)).toEqual({
      eligible: false,
      triggerCode: 'all_required_machine_proofs_bound',
    });
  });

  it('invalid input never throws', () => {
    for (const bad of [null, undefined, 1, 'x', {}, { sentinel_verdict: 'REVIEW' }]) {
      expect(() => evaluateQ1Eligibility(bad)).not.toThrow();
      expect(evaluateQ1Eligibility(bad).triggerCode).toBe('invalid_input');
    }
  });

  it('countProofStats matches missing machine required', () => {
    const stats = countProofStats(baseEligible().required_conditions);
    expect(stats.required_count).toBe(2);
    expect(stats.missing_machine_proof_count).toBe(1);
  });
});
