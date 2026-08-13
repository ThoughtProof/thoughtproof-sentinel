/**
 * ADR-0020 Pure Q1 Escalation Judge (v0)
 *
 * Deterministic eligibility only. No RV, network, models, oracle, or verdict mutation.
 * Independent of measurement pack builder predicate (no shared import).
 *
 * Consumes structured runtime fields only. Does not read case_id for decisions.
 */

/** @typedef {'multi_conjunct_missing_machine_proof'|'not_review'|'reason_not_eligible'|'insufficient_required_conditions'|'all_required_machine_proofs_bound'|'invalid_input'} TriggerCode */

/**
 * @typedef {object} EscalationDecision
 * @property {boolean} eligible
 * @property {TriggerCode} triggerCode
 */

const ELIGIBLE_REASON = 'conditional_allow_no_machine_proof';
const FRESH_OK = new Set(['fresh', 'current']);
const EID_RE = /^evidence:[a-z0-9][a-z0-9_-]{1,63}$/;

/**
 * Structural validity of one evidence binding.
 * Does NOT interpret prose. Uses only typed binding fields.
 * Independent reimplementation (not imported from pack builder).
 *
 * @param {unknown} binding
 * @param {string} conditionId
 * @returns {boolean}
 */
function isValidBoundMachineEvidence(binding, conditionId) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  const b = /** @type {Record<string, unknown>} */ (binding);
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
 * Count valid bound machine proofs for one required condition.
 * Prefers recomputation from bindings (authoritative for metamorphic safety).
 * Falls back to valid_bound_evidence_count only when bindings array is absent.
 *
 * @param {unknown} condition
 * @returns {number|null} null if condition shape invalid
 */
function validBoundCount(condition) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return null;
  const c = /** @type {Record<string, unknown>} */ (condition);
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

  // Fallback: precomputed count only if bindings omitted
  if (typeof c.valid_bound_evidence_count === 'number' && Number.isInteger(c.valid_bound_evidence_count) && c.valid_bound_evidence_count >= 0) {
    return c.valid_bound_evidence_count;
  }
  return null;
}

/**
 * Pure Q1 eligibility.
 * Intentionally ignores case_id, class_id, notes, pack_meta, action_hash, oracle fields.
 *
 * @param {unknown} runtime
 * @returns {EscalationDecision}
 */
export function evaluateQ1Eligibility(runtime) {
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    return { eligible: false, triggerCode: 'invalid_input' };
  }
  const r = /** @type {Record<string, unknown>} */ (runtime);

  if (typeof r.sentinel_verdict !== 'string') {
    return { eligible: false, triggerCode: 'invalid_input' };
  }
  if (typeof r.reason_code !== 'string') {
    return { eligible: false, triggerCode: 'invalid_input' };
  }
  if (!Array.isArray(r.required_conditions)) {
    return { eligible: false, triggerCode: 'invalid_input' };
  }

  // Validate each condition shape early (fail closed to invalid_input, no throw)
  for (const cond of r.required_conditions) {
    if (validBoundCount(cond) === null) {
      return { eligible: false, triggerCode: 'invalid_input' };
    }
  }

  if (r.sentinel_verdict !== 'REVIEW') {
    return { eligible: false, triggerCode: 'not_review' };
  }

  if (r.reason_code !== ELIGIBLE_REASON) {
    return { eligible: false, triggerCode: 'reason_not_eligible' };
  }

  /** @type {Array<Record<string, unknown>>} */
  const required = [];
  for (const cond of r.required_conditions) {
    const c = /** @type {Record<string, unknown>} */ (cond);
    if (c.required === true) required.push(c);
  }

  // Optional conditions do not count toward multi-conjunct threshold
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

export const Q1_JUDGE_VERSION = 'adr0020.q1.judge.v0';
export const Q1_ELIGIBLE_REASON_CODE = ELIGIBLE_REASON;
