/**
 * Public diagnostics, not a full receipt or a signed-export verification bundle.
 * Treat every response string (including JSON key names) as untrusted. Free text,
 * identity echoes and canonical bodies are omitted; machine diagnostics have
 * closed vocabularies/types. New fields/enum values require deliberate review.
 * Scoring must always use the ORIGINAL response, never this projection.
 */
const oneOf = (...values) => (value) => values.includes(value);
const matches = (pattern) => (value) => typeof value === 'string' && pattern.test(value);
const bool = (value) => typeof value === 'boolean';
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const unit = (value) => number(value) && value <= 1;
const hash = matches(/^0x[a-f0-9]{64}$/);
const receiptId = matches(/^sent_[a-f0-9]{16}$/);
const verdict = oneOf('ALLOW', 'BLOCK', 'UNCERTAIN');
const internalVerdict = oneOf('ALLOW', 'BLOCK', 'HOLD', 'CONDITIONAL_ALLOW', 'REVIEW', 'UNCERTAIN');
const kind = oneOf('informational', 'value_transfer', 'permission', 'deploy_ship', 'unknown');
const promotionReason = oneOf(
  'not_action_authorization', 'already_allow', 'already_block',
  'primary_block_disagreement', 'primary_error_fail_closed',
  'conditional_allow_no_machine_proof', 'steps_not_all_pass',
  'promoted_all_steps_pass', 'no_promote_path', 'objective_mismatch_fail_closed',
  'unclassified_abstention_fail_closed', 'engine_budget_exhausted', 'inferential_step_promoted',
);
const cascadeReason = oneOf(
  'primary_block', 'confirmed_block', 'primary_block_rejected', 'primary_hold',
  'agreement_allow', 'agreement_conditional_allow', 'disagreement_hold',
  'disagreement_conditional_hold', 'cascade_disabled', 'primary_error_fallback',
  'secondary_error_fallback', 'both_error', 'engine_budget_exhausted',
);
const reason = (value) => promotionReason(value) || cascadeReason(value);
const decisionBasis = oneOf('deterministic', 'cascade');
const promotion = {
  cascade_reason: cascadeReason, internal_verdict: internalVerdict,
  mapped_verdict: verdict, public_verdict: verdict,
  promoted: bool, reason: promotionReason, steps_all_pass: bool,
  machine_condition_proof_present: bool, machine_condition_proof_accepted: bool,
  action_kind: kind, mandate_kind: kind,
  action_kind_source: oneOf('caller', 'prose'), mandate_kind_source: oneOf('caller', 'prose'),
  unknown_action: bool, unknown_mandate: bool, unclassified_abstention: bool,
  decision_basis: decisionBasis,
  release_id: matches(/^[a-f0-9]{7,40}$/),
  policy: oneOf(
    'adr-0018-trade-reasoning-step2-promotion',
    'adr-0019-cascade-promotion-2026-08-08+p0-primary-error-fail-closed+p0-objective-mismatch-fail-closed+p0-informational-allowlist+p0-unknown-action-fail-closed+p0-unclassified-abstention-uncertain+p0-caller-declared-kinds',
  ),
};
const objections = {
  step: oneOf('0', '1', '2', '3'), step_id: oneOf('step_0', 'step_1', 'step_2', 'step_3'),
  score: unit,
  predicate: oneOf('faithful', 'unfaithful', 'weakly_faithful', 'partially_faithful',
    'supported', 'unsupported', 'partial', 'skipped', 'unauthorized'),
  quote_source: oneOf('cascade', 'recovered_mandate'),
  quote_match_mode: oneOf('exact', 'trimmed', 'line_whitespace', 'unicode', 'none'),
  objection_source: oneOf('cascade', 'deterministic_gate'),
  criterion: null, quote: null, reasoning: null,
};
const engineBudget = {
  reason: oneOf('engine_budget_exhausted'), degradedMode: bool,
  stage: oneOf('pre_cascade', 'primary', 'secondary', 'solo', 'post_cascade', 'unknown'),
  elapsed_ms: number, budget_ms: number, reserve_ms: number, vercel_max_duration_s: number,
  known_internal_verdict: internalVerdict, public_verdict: verdict, late_result_ignored: bool,
};
const evidenceBind = {
  surface_gated: bool, n_evidence_fail: count, n_unverified: count, n_verified: count,
  codes: [oneOf('numeric_identifier_not_spend', 'numeric_exceed_false', 'numeric_exceed_true_numbers_fixed',
    'numeric_exceed_true', 'numeric_within_false', 'numeric_within_true', 'numeric_unverified')],
  verdict_unchanged: bool,
};
const meta = {
  duration_ms: number, models_used: [oneOf('serv-nano', 'serv-swift', 'serv-pro')],
  verified_at: matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  promotion, engine_budget: engineBudget, objection_evidence_bind: evidenceBind,
  agent_context: null,
};
const attestation = { schema_uid: hash, claim_hash: hash, evidence_hash: hash };
const billing = {
  price_usd: number, settled: bool,
  platform: oneOf('direct', 'rapidapi', 'x402', 'api-key'),
  payment_method: oneOf('api-key', 'x402', 'x402-facilitator', 'free'),
};
// Digest is only a correlation reference to the original private export.
// Never rewrite canonical under its old signature or imply it verifies this copy.
const signedExport = { digest: hash, canonical: null, signature: null, keyId: null, alg: null };
const receiptSchema = {
  id: receiptId, verdict, confidence: unit,
  mode: oneOf('action_authorization'), tier: oneOf('checkpoint', 'standard', 'swift', 'pro', 'swift-real'),
  objections: [objections], meta, attestation, billing, signed_export: signedExport,
  reasoning: null,
};

const keys = (schema) => Object.freeze(Object.keys(schema).filter((key) => schema[key] !== null));
export const SUITE_RECEIPT_ALLOWLIST = Object.freeze({
  receipt: keys(receiptSchema), objections: keys(objections), meta: keys(meta),
  promotion: keys(promotion), engine_budget: keys(engineBudget), objection_evidence_bind: keys(evidenceBind),
  attestation: keys(attestation), billing: keys(billing), signed_export: keys(signedExport),
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function project(value, schema, dropped, path, secrets) {
  if (schema === null) { dropped.add(path); return undefined; }
  if (typeof value === 'string' && secrets.some((secret) => value.includes(secret))) {
    dropped.add(path); return undefined;
  }
  if (typeof schema === 'function') {
    if (value === null || schema(value)) return value;
    dropped.add(path); return undefined;
  }
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) { dropped.add(path); return undefined; }
    return value.flatMap((item) => {
      const copy = project(item, schema[0], dropped, `${path}.item`, secrets);
      return copy === undefined ? [] : [copy];
    });
  }
  if (!isPlainObject(value)) { dropped.add(path || '(non-object)'); return undefined; }
  const out = {};
  for (const key of Object.keys(value)) {
    // Do not echo unknown names: keys themselves may contain sensitive values.
    if (!has(schema, key)) { dropped.add(path ? `${path}.*` : '*'); continue; }
    const name = path ? `${path}.${key}` : key;
    const copy = project(value[key], schema[key], dropped, name, secrets);
    if (copy !== undefined) out[key] = copy;
  }
  return out;
}

/** Projection only; no mutation or scoring. Never publish raw free-text hashes. */
export function redactSuiteReceipt(receipt, { secrets = [], evidence } = {}) {
  if (receipt == null) return { receipt: null, dropped_fields: [] };
  const dropped = new Set();
  const safeSecrets = secrets.filter((s) => typeof s === 'string' && s.length > 0);
  const copy = project(receipt, receiptSchema, dropped, '', safeSecrets);
  // Keep an exact quote inspectable via the already-public fixture, without
  // trusting or publishing any response text. Never accept a server-made span.
  if (copy?.objections && typeof evidence === 'string') {
    const originals = receipt.objections.filter(isPlainObject);
    copy.objections.forEach((objection, i) => {
      const quote = originals[i].quote;
      const start = typeof quote === 'string' && quote.length > 0 ? evidence.indexOf(quote) : -1;
      if (start >= 0 && !safeSecrets.some((secret) => quote.includes(secret))) {
        objection.quote_evidence_span = { start, end: start + quote.length };
      }
    });
  }
  // Array item indices are deliberately absent from schema-drift markers.
  return { receipt: copy ?? null, dropped_fields: [...new Set([...dropped].map((p) => p.replaceAll('.item.', '.')))].sort() };
}

const rowSchema = {
  // id/expect/class are runner/fixture-owned, not echoed from the response.
  id: matches(/^[a-z0-9][a-z0-9_-]{0,95}$/), expect: oneOf('allow', 'not-allow'),
  class: oneOf('ok', 'false_ALLOW', 'false_BLOCK', 'known_false_block', 'error'),
  known_false_block: bool, uncertain_ok: bool,
  http_status: (value) => Number.isInteger(value) && value >= 100 && value <= 599,
  verdict, receipt_id: receiptId, decision_basis: decisionBasis,
  promotion: reason, promotion_reason: reason, cascade_reason: cascadeReason,
  engine_budget_reason: oneOf('engine_budget_exhausted'), reason,
  degradedMode: bool, mandate_kind: kind, action_kind: kind,
  error: (value) => oneOf('UNAUTHORIZED', 'rate_limited', 'internal', 'INTERNAL_ERROR',
    'MODEL_CONFIG_MISSING', 'engine_budget_exhausted', 'fetch_error', 'Error',
    'TypeError', 'AbortError', 'TimeoutError', 'ECONNRESET', 'ECONNREFUSED',
    'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
    'vercel_deployment_protection (set VERCEL_AUTOMATION_BYPASS_SECRET)')(value) ||
    matches(/^http_[1-5]\d\d$/)(value),
};

/** Apply to rows AND score failure lists AND console/step-summary output. */
export function redactSuiteRow(row, { secrets = [] } = {}) {
  const copy = project(row, rowSchema, new Set(), '', secrets.filter(Boolean)) ?? {};
  if (has(row, 'error') && row.error != null && !has(copy, 'error')) copy.error = 'redacted_error';
  return copy;
}

/** Target metadata must not serialize URL credentials, paths, queries or fragments. */
export function publicSuiteOrigin(value, secrets = []) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return '[redacted target]';
    return secrets.filter(Boolean).some((secret) => url.origin.includes(secret)) ? '[redacted target]' : url.origin;
  } catch { return '[redacted target]'; }
}

export function summarizeDroppedReceiptFields(cases) {
  return [...new Set((cases ?? []).flatMap((row) => row.dropped_fields ?? []))].sort();
}
