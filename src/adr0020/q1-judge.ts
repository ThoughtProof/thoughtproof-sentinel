/**
 * ADR-0020 Pure Q1 Escalation Judge (TypeScript port of frozen adr0020.q1.judge.v0)
 *
 * Deterministic eligibility only. No RV, network, models, oracle, or verdict mutation.
 * Independent of measurement pack builder. Does not branch on case_id.
 *
 * Source of truth for logic: product_run/.../q1_judge/judge.mjs (FROZEN).
 * This port must stay behavior-equivalent; bump Q1_JUDGE_VERSION if logic changes.
 */

export type TriggerCode =
  | 'multi_conjunct_missing_machine_proof'
  | 'not_review'
  | 'reason_not_eligible'
  | 'insufficient_required_conditions'
  | 'all_required_machine_proofs_bound'
  | 'invalid_input';

export interface EscalationDecision {
  eligible: boolean;
  triggerCode: TriggerCode;
}

export interface EvidenceBinding {
  evidence_id: string;
  bound_condition_id: string;
  syntactically_valid: boolean;
  freshness: 'fresh' | 'current' | 'stale' | 'expired' | 'unknown' | string;
  contradicted: boolean;
  grade: 'machine' | 'human' | 'unspecified' | string;
  valid_bound?: boolean;
}

export interface RequiredCondition {
  condition_id: string;
  required: boolean;
  proof_requirement: 'machine' | 'any' | 'none' | string;
  evidence_bindings?: EvidenceBinding[];
  valid_bound_evidence_count?: number;
}

export interface Q1RuntimeInput {
  /** Public Sentinel verdict. UNCERTAIN is treated as REVIEW for Q1. */
  sentinel_verdict: string;
  reason_code: string;
  required_conditions: RequiredCondition[];
  action_hash?: string | null;
  /** Ignored by judge — correlation only */
  case_id?: string;
}

export const Q1_JUDGE_VERSION = 'adr0020.q1.judge.v0';
export const Q1_ELIGIBLE_REASON_CODE = 'conditional_allow_no_machine_proof';

const FRESH_OK = new Set(['fresh', 'current']);
const EID_RE = /^evidence:[a-z0-9][a-z0-9_-]{1,63}$/;

/**
 * Canonicalize public Sentinel verdict for Q1 eligibility class.
 *
 * Sentinel public API emits ALLOW | BLOCK | UNCERTAIN (see types.SentinelVerdict).
 * E-4 / ADR-0020 measurement vocabulary uses REVIEW for the non-terminal hold class.
 * UNCERTAIN is the public name for that hold class — not a distinct third hold.
 *
 * Call path: source_verdict → canonicalizeVerdictForQ1() → Q1 judge.
 * Do not silently equate strings inside trigger logic without this step.
 */
export function canonicalizeVerdictForQ1(publicVerdict: string): string {
  if (publicVerdict === 'UNCERTAIN') return 'REVIEW';
  return publicVerdict;
}

/** @deprecated use canonicalizeVerdictForQ1 */
export function toQ1Verdict(publicVerdict: string): string {
  return canonicalizeVerdictForQ1(publicVerdict);
}

function isValidBoundMachineEvidence(binding: unknown, conditionId: string): boolean {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  const b = binding as Record<string, unknown>;
  if (typeof b.evidence_id !== 'string' || b.evidence_id.length === 0) return false;
  if (b.bound_condition_id !== conditionId) return false;
  if (b.syntactically_valid !== true) return false;
  if (!EID_RE.test(b.evidence_id)) return false;
  if (typeof b.freshness !== 'string' || !FRESH_OK.has(b.freshness)) return false;
  if (b.contradicted !== false) return false;
  if (b.grade !== 'machine') return false;
  return true;
}

/** @returns null if condition shape invalid */
function validBoundCount(condition: unknown): number | null {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return null;
  const c = condition as Record<string, unknown>;
  if (typeof c.condition_id !== 'string' || c.condition_id.length === 0) return null;
  if (typeof c.required !== 'boolean') return null;
  if (typeof c.proof_requirement !== 'string') return null;

  if (Array.isArray(c.evidence_bindings)) {
    let n = 0;
    for (const b of c.evidence_bindings) {
      if (isValidBoundMachineEvidence(b, c.condition_id)) n += 1;
    }
    return n;
  }

  if (
    typeof c.valid_bound_evidence_count === 'number' &&
    Number.isInteger(c.valid_bound_evidence_count) &&
    c.valid_bound_evidence_count >= 0
  ) {
    return c.valid_bound_evidence_count;
  }
  return null;
}

/**
 * Pure Q1 eligibility. Never throws.
 * Ignores case_id / notes / oracle fields.
 */
export function evaluateQ1Eligibility(runtime: unknown): EscalationDecision {
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    return { eligible: false, triggerCode: 'invalid_input' };
  }
  const r = runtime as Record<string, unknown>;

  if (typeof r.sentinel_verdict !== 'string') {
    return { eligible: false, triggerCode: 'invalid_input' };
  }
  if (typeof r.reason_code !== 'string') {
    return { eligible: false, triggerCode: 'invalid_input' };
  }
  if (!Array.isArray(r.required_conditions)) {
    return { eligible: false, triggerCode: 'invalid_input' };
  }

  for (const cond of r.required_conditions) {
    if (validBoundCount(cond) === null) {
      return { eligible: false, triggerCode: 'invalid_input' };
    }
  }

  // Prefer explicit canonical field when caller already normalized; else canonicalize source.
  const source = r.sentinel_verdict;
  const canonical =
    typeof r.canonical_verdict === 'string'
      ? r.canonical_verdict
      : canonicalizeVerdictForQ1(source);
  if (canonical !== 'REVIEW') {
    return { eligible: false, triggerCode: 'not_review' };
  }

  if (r.reason_code !== Q1_ELIGIBLE_REASON_CODE) {
    return { eligible: false, triggerCode: 'reason_not_eligible' };
  }

  const required: Record<string, unknown>[] = [];
  for (const cond of r.required_conditions) {
    const c = cond as Record<string, unknown>;
    if (c.required === true) required.push(c);
  }

  if (required.length < 2) {
    return { eligible: false, triggerCode: 'insufficient_required_conditions' };
  }

  let missingMachine = false;
  for (const c of required) {
    if (c.proof_requirement !== 'machine') continue;
    const n = validBoundCount(c);
    if (n === 0) {
      missingMachine = true;
      break;
    }
  }

  if (!missingMachine) {
    return { eligible: false, triggerCode: 'all_required_machine_proofs_bound' };
  }

  return {
    eligible: true,
    triggerCode: 'multi_conjunct_missing_machine_proof',
  };
}

export function countProofStats(required_conditions: unknown): {
  required_count: number | null;
  missing_machine_proof_count: number | null;
} {
  if (!Array.isArray(required_conditions)) {
    return { required_count: null, missing_machine_proof_count: null };
  }
  let required_count = 0;
  let missing_machine_proof_count = 0;
  for (const c of required_conditions) {
    if (!c || typeof c !== 'object') continue;
    const cond = c as Record<string, unknown>;
    if (cond.required !== true) continue;
    required_count += 1;
    if (cond.proof_requirement !== 'machine') continue;
    const n = validBoundCount(cond);
    if (n === 0) missing_machine_proof_count += 1;
  }
  return { required_count, missing_machine_proof_count };
}
