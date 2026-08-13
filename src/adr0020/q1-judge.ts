/**
 * ADR-0020 Pure Q1 Escalation Judge (TypeScript port of frozen adr0020.q1.judge.v0)
 *
 * Deterministic eligibility only. No RV, network, models, oracle, or verdict mutation.
 * Independent of measurement pack builder. Does not branch on case_id.
 *
 * Trust boundary (v0):
 * - Verdict canonicalization is INTERNAL only (source → canonicalize).
 * - Caller-supplied canonical_verdict is never trusted for decisions.
 * - valid_bound_evidence_count is NEVER used as decision input.
 * - evidence_bindings fields are caller-asserted until server verifies them.
 *
 * Bump Q1_JUDGE_VERSION when logic changes.
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
  /** Ignored for decisions if present — caller assertion only */
  valid_bound?: boolean;
}

export interface RequiredCondition {
  condition_id: string;
  required: boolean;
  proof_requirement: 'machine' | 'any' | 'none' | string;
  evidence_bindings?: EvidenceBinding[];
  /**
   * @deprecated Never used for Q1 decisions. Caller-supplied counts are untrusted.
   * Kept optional only for forward-compat diagnostics outside the judge.
   */
  valid_bound_evidence_count?: number;
}

export interface Q1RuntimeInput {
  /** Public / source Sentinel verdict (ALLOW|BLOCK|UNCERTAIN|REVIEW). */
  sentinel_verdict: string;
  reason_code: string;
  required_conditions: RequiredCondition[];
  action_hash?: string | null;
  /** Ignored by judge — correlation only */
  case_id?: string;
  /**
   * If supplied, must equal canonicalizeVerdictForQ1(source).
   * Mismatch → invalid_input. Never used as the decision source.
   */
  canonical_verdict?: string;
}

export const Q1_JUDGE_VERSION = 'adr0020.q1.judge.v0.1';
export const Q1_ELIGIBLE_REASON_CODE = 'conditional_allow_no_machine_proof';

const FRESH_OK = new Set(['fresh', 'current']);
const EID_RE = /^evidence:[a-z0-9][a-z0-9_-]{1,63}$/;

/**
 * Canonicalize public Sentinel verdict for Q1 eligibility class.
 *
 * Sentinel public API emits ALLOW | BLOCK | UNCERTAIN.
 * E-4 / ADR-0020 measurement vocabulary uses REVIEW for the non-terminal hold class.
 * UNCERTAIN is the public name for that hold class — not a distinct third hold.
 *
 * Call path: source_verdict → canonicalizeVerdictForQ1() → Q1 judge.
 */
export function canonicalizeVerdictForQ1(publicVerdict: string): string {
  if (publicVerdict === 'UNCERTAIN') return 'REVIEW';
  return publicVerdict;
}

/** @deprecated use canonicalizeVerdictForQ1 */
export function toQ1Verdict(publicVerdict: string): string {
  return canonicalizeVerdictForQ1(publicVerdict);
}

/**
 * Structural validity of one evidence binding from typed fields only.
 * NOTE: In v0 these fields are caller-asserted unless the shadow layer marks
 * binding_source=server_verified. Judge still applies structural checks so
 * garbage shapes fail closed; trust is labeled on the shadow event.
 */
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

/**
 * Count valid bound machine proofs for one condition.
 * - If evidence_bindings is an array: recompute from bindings only.
 * - If evidence_bindings is missing/null/not-array: count = 0 (unproven).
 * - NEVER trusts valid_bound_evidence_count.
 * @returns null if condition shape invalid
 */
function validBoundCount(condition: unknown): number | null {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return null;
  const c = condition as Record<string, unknown>;
  if (typeof c.condition_id !== 'string' || c.condition_id.length === 0) return null;
  if (typeof c.required !== 'boolean') return null;
  if (typeof c.proof_requirement !== 'string') return null;

  // Missing bindings ⇒ no proven machine evidence (not a fallback to caller count).
  if (!Array.isArray(c.evidence_bindings)) {
    return 0;
  }

  let n = 0;
  for (const b of c.evidence_bindings) {
    if (isValidBoundMachineEvidence(b, c.condition_id)) n += 1;
  }
  return n;
}

/**
 * Pure Q1 eligibility. Never throws.
 * Ignores case_id / notes / oracle fields.
 * Does not trust caller-supplied canonical_verdict or precomputed counts.
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

  // Duplicate condition_id → invalid (must not inflate multi-conjunct).
  const seen = new Set<string>();
  for (const cond of r.required_conditions) {
    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) {
      return { eligible: false, triggerCode: 'invalid_input' };
    }
    const cid = (cond as Record<string, unknown>).condition_id;
    if (typeof cid !== 'string') {
      return { eligible: false, triggerCode: 'invalid_input' };
    }
    if (seen.has(cid)) {
      return { eligible: false, triggerCode: 'invalid_input' };
    }
    seen.add(cid);
    if (validBoundCount(cond) === null) {
      return { eligible: false, triggerCode: 'invalid_input' };
    }
  }

  // INTERNAL canonicalize only — never prefer caller canonical_verdict.
  const source = r.sentinel_verdict;
  const canonical = canonicalizeVerdictForQ1(source);
  if (typeof r.canonical_verdict === 'string' && r.canonical_verdict !== canonical) {
    return { eligible: false, triggerCode: 'invalid_input' };
  }

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
