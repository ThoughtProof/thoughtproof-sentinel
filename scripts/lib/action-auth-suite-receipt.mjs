/**
 * Allowlist for the public action-authorization suite artifact.
 *
 * The report is uploaded as a GitHub Actions artifact on a public repo.
 * Receipts are copied field-by-field. Any key not listed here is omitted
 * and its name is recorded (never its value), so a later caller, account,
 * or tenant field cannot leak by riding along on a verbatim receipt.
 *
 * Live objections use `step_id` (SentinelStepObjection). `step` is the
 * same slot when a receipt names it that way. `meta.promotion` is the
 * promotion-layer trace and is kept in full (`promotion.*`) as JSON.
 * Scoring still reads the original response; this module only shapes
 * the archived copy.
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** @type {const} */
export const SUITE_RECEIPT_ALLOWLIST = Object.freeze({
  receipt: Object.freeze([
    'id',
    'verdict',
    'confidence',
    'reasoning',
    'objections',
    'mode',
    'tier',
    'meta',
    'attestation',
    'billing',
    'signed_export',
  ]),
  objections: Object.freeze([
    'step',
    'step_id',
    'criterion',
    'score',
    'predicate',
    'quote',
    'reasoning',
  ]),
  meta: Object.freeze([
    'duration_ms',
    'models_used',
    'verified_at',
    'promotion',
    'agent_context',
  ]),
  /** Every JSON field under meta.promotion. */
  promotion: '*',
  agent_context: Object.freeze([
    'agent_id',
    'agent_runtime',
    'external_request_id',
    'tags',
    'identity_source',
    'identity_verified',
  ]),
  attestation: Object.freeze(['schema_uid', 'claim_hash', 'evidence_hash']),
  billing: Object.freeze(['price_usd', 'settled', 'platform', 'payment_method']),
  signed_export: Object.freeze(['digest', 'keyId', 'alg', 'signature', 'canonical']),
});

const TOP_SCALARS = Object.freeze({
  id: ['string'],
  verdict: ['string'],
  confidence: ['number'],
  reasoning: ['string'],
  mode: ['string'],
  tier: ['string'],
});

const OBJECTION_KINDS = Object.freeze({
  step: ['string'],
  step_id: ['string'],
  criterion: ['string'],
  score: ['number'],
  predicate: ['string'],
  quote: ['string'],
  reasoning: ['string'],
});

const AGENT_KINDS = Object.freeze({
  agent_id: ['string'],
  agent_runtime: ['string'],
  external_request_id: ['string'],
  identity_source: ['string'],
  identity_verified: ['boolean'],
});

const ATTESTATION_KINDS = Object.freeze({
  schema_uid: ['string'],
  claim_hash: ['string'],
  evidence_hash: ['string'],
});

const BILLING_KINDS = Object.freeze({
  price_usd: ['number'],
  settled: ['boolean'],
  platform: ['string'],
  payment_method: ['string'],
});

const SIGNED_EXPORT_KINDS = Object.freeze({
  digest: ['string'],
  keyId: ['string'],
  alg: ['string'],
  signature: ['string'],
  canonical: ['string'],
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function note(dropped, name) {
  dropped.add(name);
}

function assign(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @param {string[]} kinds
 */
function copyScalar(value, kinds) {
  if (value === null) return { ok: true, value: null };
  if (kinds?.includes('string') && typeof value === 'string') return { ok: true, value };
  if (kinds?.includes('number') && isFiniteNumber(value)) return { ok: true, value };
  if (kinds?.includes('boolean') && typeof value === 'boolean') return { ok: true, value };
  return { ok: false };
}

function fieldPath(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
}

function copyScalarsInto(target, source, keys, kinds, dropped, prefix) {
  for (const key of keys) {
    if (!has(source, key)) continue;
    const copied = copyScalar(source[key], kinds[key]);
    if (!copied.ok) {
      note(dropped, fieldPath(prefix, key));
      continue;
    }
    assign(target, key, copied.value);
  }
}

/**
 * @param {unknown} value
 * @param {Set<string>} dropped
 * @param {string} path
 * @returns {string[] | undefined}
 */
function copyStringArray(value, dropped, path) {
  if (!Array.isArray(value)) {
    note(dropped, path);
    return undefined;
  }
  const out = [];
  let rejected = false;
  for (const el of value) {
    if (typeof el === 'string') out.push(el);
    else rejected = true;
  }
  if (rejected) note(dropped, `${path}.item`);
  return out;
}

/**
 * JSON-safe clone. Rejects functions, bigint, and prototype keys.
 * @param {unknown} value
 * @returns {{ ok: true, value: unknown } | { ok: false }}
 */
function jsonValue(value) {
  if (value === null) return { ok: true, value: null };
  if (typeof value === 'string' || typeof value === 'boolean') return { ok: true, value };
  if (isFiniteNumber(value)) return { ok: true, value };
  if (Array.isArray(value)) {
    const out = [];
    for (const el of value) {
      const child = jsonValue(el);
      if (!child.ok) return { ok: false };
      out.push(child.value);
    }
    return { ok: true, value: out };
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) return { ok: false };
      const child = jsonValue(value[key]);
      if (!child.ok) return { ok: false };
      assign(out, key, child.value);
    }
    return { ok: true, value: out };
  }
  return { ok: false };
}

function noteUnknownKeys(source, allowed, dropped, prefix) {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) note(dropped, fieldPath(prefix, key));
  }
}

/**
 * @param {unknown} value
 * @param {Set<string>} dropped
 */
function redactObjections(value, dropped) {
  if (!Array.isArray(value)) {
    note(dropped, 'objections');
    return undefined;
  }
  const keys = SUITE_RECEIPT_ALLOWLIST.objections;
  const allowed = new Set(keys);
  return value.map((item) => {
    if (!isPlainObject(item)) {
      note(dropped, 'objections.item');
      return {};
    }
    noteUnknownKeys(item, allowed, dropped, 'objections');
    const out = {};
    copyScalarsInto(out, item, keys, OBJECTION_KINDS, dropped, 'objections');
    return out;
  });
}

/**
 * @param {unknown} value
 * @param {Set<string>} dropped
 */
function redactPromotion(value, dropped) {
  if (!isPlainObject(value)) {
    note(dropped, 'meta.promotion');
    return undefined;
  }
  const out = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      note(dropped, `meta.promotion.${key}`);
      continue;
    }
    const cloned = jsonValue(value[key]);
    if (!cloned.ok) {
      note(dropped, `meta.promotion.${key}`);
      continue;
    }
    assign(out, key, cloned.value);
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {Set<string>} dropped
 */
function redactAgentContext(value, dropped) {
  if (!isPlainObject(value)) {
    note(dropped, 'meta.agent_context');
    return undefined;
  }
  const keys = SUITE_RECEIPT_ALLOWLIST.agent_context;
  noteUnknownKeys(value, new Set(keys), dropped, 'meta.agent_context');
  const out = {};
  copyScalarsInto(
    out,
    value,
    ['agent_id', 'agent_runtime', 'external_request_id', 'identity_source', 'identity_verified'],
    AGENT_KINDS,
    dropped,
    'meta.agent_context',
  );
  if (has(value, 'tags')) {
    const tags = copyStringArray(value.tags, dropped, 'meta.agent_context.tags');
    if (tags !== undefined) assign(out, 'tags', tags);
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {Set<string>} dropped
 */
function redactMeta(value, dropped) {
  if (!isPlainObject(value)) {
    note(dropped, 'meta');
    return undefined;
  }
  noteUnknownKeys(value, new Set(SUITE_RECEIPT_ALLOWLIST.meta), dropped, 'meta');
  const out = {};
  copyScalarsInto(
    out,
    value,
    ['duration_ms', 'verified_at'],
    { duration_ms: ['number'], verified_at: ['string'] },
    dropped,
    'meta',
  );
  if (has(value, 'models_used')) {
    const models = copyStringArray(value.models_used, dropped, 'meta.models_used');
    if (models !== undefined) assign(out, 'models_used', models);
  }
  if (has(value, 'promotion')) {
    const promotion = redactPromotion(value.promotion, dropped);
    if (promotion !== undefined) assign(out, 'promotion', promotion);
  }
  if (has(value, 'agent_context')) {
    const agent = redactAgentContext(value.agent_context, dropped);
    if (agent !== undefined) assign(out, 'agent_context', agent);
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @param {Record<string, string[]>} kinds
 * @param {Set<string>} dropped
 * @param {string} prefix
 */
function redactNamedObject(value, keys, kinds, dropped, prefix) {
  if (!isPlainObject(value)) {
    note(dropped, prefix);
    return undefined;
  }
  noteUnknownKeys(value, new Set(keys), dropped, prefix);
  const out = {};
  copyScalarsInto(out, value, keys, kinds, dropped, prefix);
  return out;
}

/**
 * Copy one receipt through the public allowlist.
 *
 * @param {unknown} receipt
 * @returns {{ receipt: Record<string, unknown> | null, dropped_fields: string[] }}
 */
export function redactSuiteReceipt(receipt) {
  const dropped = new Set();
  if (receipt == null) return { receipt: null, dropped_fields: [] };
  if (!isPlainObject(receipt)) return { receipt: null, dropped_fields: ['(non-object)'] };

  noteUnknownKeys(receipt, new Set(SUITE_RECEIPT_ALLOWLIST.receipt), dropped, '');
  const out = {};
  copyScalarsInto(
    out,
    receipt,
    ['id', 'verdict', 'confidence', 'reasoning', 'mode', 'tier'],
    TOP_SCALARS,
    dropped,
    '',
  );
  if (has(receipt, 'objections')) {
    const objections = redactObjections(receipt.objections, dropped);
    if (objections !== undefined) assign(out, 'objections', objections);
  }
  if (has(receipt, 'meta')) {
    const meta = redactMeta(receipt.meta, dropped);
    if (meta !== undefined) assign(out, 'meta', meta);
  }
  if (has(receipt, 'attestation')) {
    const attestation = redactNamedObject(
      receipt.attestation,
      SUITE_RECEIPT_ALLOWLIST.attestation,
      ATTESTATION_KINDS,
      dropped,
      'attestation',
    );
    if (attestation !== undefined) assign(out, 'attestation', attestation);
  }
  if (has(receipt, 'billing')) {
    const billing = redactNamedObject(
      receipt.billing,
      SUITE_RECEIPT_ALLOWLIST.billing,
      BILLING_KINDS,
      dropped,
      'billing',
    );
    if (billing !== undefined) assign(out, 'billing', billing);
  }
  if (has(receipt, 'signed_export')) {
    const signed = redactNamedObject(
      receipt.signed_export,
      SUITE_RECEIPT_ALLOWLIST.signed_export,
      SIGNED_EXPORT_KINDS,
      dropped,
      'signed_export',
    );
    if (signed !== undefined) assign(out, 'signed_export', signed);
  }
  return { receipt: out, dropped_fields: [...dropped].sort() };
}

/**
 * Sorted unique dropped-field names across archived cases.
 * Values are never included.
 *
 * @param {Array<{ dropped_fields?: string[] }> | null | undefined} cases
 * @returns {string[]}
 */
export function summarizeDroppedReceiptFields(cases) {
  const names = new Set();
  for (const row of cases ?? []) {
    const fields = row?.dropped_fields;
    if (!Array.isArray(fields)) continue;
    for (const name of fields) {
      if (typeof name === 'string' && name) names.add(name);
    }
  }
  return [...names].sort();
}
