#!/usr/bin/env node
/**
 * Portable verifier for ThoughtProof Sentinel M1 signed canonical exports.
 *
 * Zero repo dependency beyond Node 18+ (built-in crypto only).
 *
 *   node scripts/verify-canonical-export.mjs <export.json> \
 *     [--keys path-or-url] [--now unix] [--require-valid-until] \
 *     [--allow-vector-only] [--schema v1|v2|all|auto] [--v2] \
 *     [--mandate file.json] [--action file.json] [--digest-salt hex]
 *
 * --schema (default auto):
 *   v1   verify signed_export / a v1 envelope only; fail if it is missing or invalid
 *   v2   verify signed_export_v2 / a v2 envelope only; fail if it is missing or invalid
 *   all  verify every present export; any present-but-invalid export fails
 *   auto same selection as all (bare envelope, or whichever response fields exist)
 * --v2 is shorthand for --schema v2.
 * A response field counts as present when the key exists, including null.
 * null, strings, arrays and other non-objects are invalid (invalid_export).
 * signed_export must be canonical v1 and signed_export_v2 must be canonical v2
 * (schema_field_mismatch otherwise). A document that is both a top-level
 * envelope and a response (signed_export* keys) is ambiguous_input.
 * Result JSON includes verified_schemas (schemas that passed). A failure also
 * names failed_schema. A full API response is not "v1 only".
 *
 * Default keys URL:
 *   https://sentinel.thoughtproof.ai/.well-known/thoughtproof-keys.json
 *
 * Key document: thoughtproof.keys.v1 (OKP + TP status extensions) — not pure JWKS.
 * JWK alg = EdDSA (JOSE). Envelope alg = Ed25519. Do not cross-compare them.
 *
 * Verification order (PriorSeal §4):
 *   1. artifactSchema is sentinel.verdict.canonical.v1 or .v2 (ADR-0022)
 *   2. resolve keyId against key doc
 *        - notBefore/notAfter vs export **signedAt** (not verifier clock)
 *        - status=retired still verifies in-window historical sigs
 *        - vector-only needs --allow-vector-only
 *   3. Ed25519 verify domain||0x00||JCS(fields)  → DECISION_SIGNATURE_INVALID on fail
 *   4. sha256(UTF-8(transported canonical)) === digest → DECISION_COMMITMENT_DIGEST_MISMATCH
 *   5. optional validUntil vs verifier --now (freshness)
 *
 * DECISION_SIGNER_UNTRUSTED is reserved for key_not_found / window / vector-only —
 * not for a broken signature on a known key.
 *
 * Optional salted-commitment recompute (ADR-0022 addendum), v2 only:
 *   --mandate <json>  --action <json>  --digest-salt <64 hex chars>
 * When any of those flags is set the check is mandatory and fails closed.
 * Digest is sha256(raw salt bytes || UTF-8(JCS(value))), encoded
 * `sha256:` + lowercase hex. JCS matches the canonicalize package used by
 * src/package-digest.ts. Without the flags, verification is unchanged.
 * The salt is required: an unsalted sha256 of a low-entropy mandate is
 * dictionary-reversible. This script does not fetch a mandate or a salt.
 */
import {
  createPublicKey,
  createHash,
  verify as cryptoVerify,
} from 'crypto';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

const DOMAIN = 'thoughtproof.sentinel.export.v1';
const SCHEMA_V1 = 'sentinel.verdict.canonical.v1';
const SCHEMA_V2 = 'sentinel.verdict.canonical.v2';
const ACCEPTED_ARTIFACT_SCHEMAS = new Set([SCHEMA_V1, SCHEMA_V2]);
const SCHEMA_MODES = new Set(['v1', 'v2', 'all', 'auto']);
const DEFAULT_KEYS =
  process.env.THOUGHTPROOF_KEYS_URL ||
  'https://sentinel.thoughtproof.ai/.well-known/thoughtproof-keys.json';

function jcsFlat(obj) {
  const keys = Object.keys(obj).sort();
  const parts = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    let enc;
    if (typeof v === 'string') enc = JSON.stringify(v);
    else if (typeof v === 'number' && Number.isFinite(v)) enc = JSON.stringify(v);
    else if (typeof v === 'boolean') enc = v ? 'true' : 'false';
    else throw new Error(`jcsFlat: unsupported type for ${k}`);
    parts.push(`${JSON.stringify(k)}:${enc}`);
  }
  return `{${parts.join(',')}}`;
}

function buildSignedInput(fields) {
  const body = {
    artifactSchema: fields.artifactSchema,
    verificationId: fields.verificationId,
    canonical: fields.canonical,
    digest: fields.digest,
    keyId: fields.keyId,
    alg: fields.alg,
    signedAt: fields.signedAt,
  };
  if (fields.validUntil !== undefined) body.validUntil = fields.validUntil;
  return Buffer.concat([
    Buffer.from(DOMAIN, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(jcsFlat(body), 'utf8'),
  ]);
}

function digestCanonical(canonical) {
  return '0x' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * JCS (RFC 8785) via the same algorithm as the `canonicalize` package
 * (src/package-digest.ts). JSON inputs have no undefined, NaN, or cycles.
 * A non-JSON value throws so the commitment check fails closed.
 */
export function jcsCanonicalize(object, seen = new Set()) {
  if (typeof object === 'number' && Number.isNaN(object)) {
    throw new Error('NaN is not allowed');
  }
  if (typeof object === 'number' && !Number.isFinite(object)) {
    throw new Error('Infinity is not allowed');
  }
  if (object === null || typeof object !== 'object') {
    return JSON.stringify(object);
  }
  if (typeof object.toJSON === 'function') {
    if (seen.has(object)) throw new Error('Circular reference detected');
    seen.add(object);
    const result = jcsCanonicalize(object.toJSON(), seen);
    seen.delete(object);
    return result;
  }
  if (seen.has(object)) throw new Error('Circular reference detected');
  seen.add(object);
  let result;
  if (Array.isArray(object)) {
    const values = object.map((item) => {
      const value = item === undefined || typeof item === 'symbol' ? null : item;
      return jcsCanonicalize(value, seen);
    });
    result = `[${values.join(',')}]`;
  } else {
    const parts = [];
    for (const key of Object.keys(object).sort()) {
      if (object[key] === undefined || typeof object[key] === 'symbol') continue;
      parts.push(`${jcsCanonicalize(key)}:${jcsCanonicalize(object[key], seen)}`);
    }
    result = `{${parts.join(',')}}`;
  }
  seen.delete(object);
  return result;
}

/** sha256(salt || UTF-8(JCS(value))) as `sha256:` + lowercase hex. */
export function portableSaltedCommitmentDigest(value, salt) {
  if (!Buffer.isBuffer(salt) || salt.length !== 32) {
    throw new Error('commitment salt must be 32 bytes');
  }
  const canonical = jcsCanonicalize(value);
  if (typeof canonical !== 'string') {
    throw new Error('JCS did not return a string');
  }
  return `sha256:${createHash('sha256').update(salt).update(canonical, 'utf8').digest('hex')}`;
}

function parseCommitmentSalt(hex) {
  if (typeof hex !== 'string' || hex.length === 0) {
    return { error: 'commitment_salt_invalid', detail: 'digest salt must be 64 hex characters (32 bytes)' };
  }
  const bare = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) {
    return { error: 'commitment_salt_invalid', detail: 'digest salt must be 64 hex characters (32 bytes)' };
  }
  return { salt: Buffer.from(bare, 'hex') };
}

function readCommitmentJson(filePath, label) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return { error: 'commitment_input_invalid', detail: `${label} JSON could not be read` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: 'commitment_input_invalid', detail: `${label} JSON could not be parsed` };
  }
}

/**
 * Optional recompute. null = not requested.
 * Any supplied flag makes the check mandatory. Fail closed on incomplete
 * input, a missing digest, a bad salt, or a mismatch. Does not echo the
 * mandate, the action, or the salt.
 */
export function checkSaltedCommitments(artifacts, args) {
  const requested = Boolean(args.mandateFlag || args.actionFlag || args.digestSaltFlag);
  if (!requested) return null;
  if (!args.digestSalt || (!args.mandateFlag && !args.actionFlag) ||
      (args.mandateFlag && !args.mandatePath) || (args.actionFlag && !args.actionPath)) {
    return {
      ok: false,
      exitCode: 4,
      error: 'commitment_input_incomplete',
      detail: '--digest-salt plus --mandate and/or --action are required together',
    };
  }
  const v2 = (artifacts || []).filter((artifact) => artifact && artifact.artifactSchema === SCHEMA_V2);
  if (v2.length === 0) {
    return {
      ok: false,
      exitCode: 4,
      error: 'commitment_schema_unsupported',
      detail: 'mandateDigest and actionDigest exist only on canonical v2',
    };
  }
  const parsedSalt = parseCommitmentSalt(args.digestSalt);
  if (parsedSalt.error) {
    return { ok: false, exitCode: 4, error: parsedSalt.error, detail: parsedSalt.detail };
  }
  let mandate;
  let action;
  if (args.mandateFlag) {
    const loaded = readCommitmentJson(args.mandatePath, 'mandate');
    if (loaded.error) return { ok: false, exitCode: 4, error: loaded.error, detail: loaded.detail };
    mandate = loaded.value;
  }
  if (args.actionFlag) {
    const loaded = readCommitmentJson(args.actionPath, 'action');
    if (loaded.error) return { ok: false, exitCode: 4, error: loaded.error, detail: loaded.detail };
    action = loaded.value;
  }

  const fields = [];
  for (const artifact of v2) {
    let body;
    try {
      body = JSON.parse(artifact.canonical);
    } catch {
      return { ok: false, exitCode: 4, error: 'commitment_mismatch', detail: 'v2 canonical is not JSON' };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, exitCode: 4, error: 'commitment_mismatch', detail: 'v2 canonical is not an object' };
    }
    if (args.mandateFlag) {
      const check = matchCommitment('mandateDigest', body.mandateDigest, mandate, parsedSalt.salt);
      if (!check.ok) return check;
      fields.push('mandateDigest');
    }
    if (args.actionFlag) {
      const check = matchCommitment('actionDigest', body.actionDigest, action, parsedSalt.salt);
      if (!check.ok) return check;
      fields.push('actionDigest');
    }
  }
  return { ok: true, fields: [...new Set(fields)] };
}

function matchCommitment(field, actual, value, salt) {
  if (typeof actual !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(actual)) {
    return { ok: false, exitCode: 4, error: 'commitment_missing', field };
  }
  let recomputed;
  try {
    recomputed = portableSaltedCommitmentDigest(value, salt);
  } catch {
    return { ok: false, exitCode: 4, error: 'commitment_mismatch', field, detail: 'recompute failed' };
  }
  if (recomputed !== actual) {
    return {
      ok: false,
      exitCode: 4,
      error: 'commitment_mismatch',
      field,
      code: 'DECISION_COMMITMENT_DIGEST_MISMATCH',
    };
  }
  return { ok: true };
}

function resolvePub(entry) {
  if (entry.kty === 'OKP' && entry.crv === 'Ed25519' && typeof entry.x === 'string') {
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: entry.x },
      format: 'jwk',
    });
  }
  if (entry.publicKeyPem) return createPublicKey(entry.publicKeyPem);
  if (entry.publicKey && /^[0-9a-fA-F]{64}$/.test(entry.publicKey)) {
    const raw = Buffer.from(entry.publicKey, 'hex');
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      raw,
    ]);
    return createPublicKey({ key: spki, format: 'der', type: 'spki' });
  }
  throw new Error('key entry missing OKP x (or legacy publicKeyPem/publicKey)');
}

/**
 * Key usable for verifying an *existing* export.
 * - notBefore/notAfter vs **signedAt** (historical verify after rotation)
 * - status=retired: still OK if signedAt in window (denies new trust only at sign time)
 * - status=vector-only: needs --allow-vector-only
 * - validUntil is checked later vs verifier --now
 */
function keyUsable(entry, allowVectorOnly, signedAt) {
  const status = entry.status || 'active';
  if (status === 'vector-only') {
    if (!allowVectorOnly) {
      return { ok: false, reason: 'vector_only_key_not_allowed', code: 'DECISION_SIGNER_UNTRUSTED' };
    }
  } else if (status !== 'active' && status !== 'retired') {
    return { ok: false, reason: 'key_status_unusable', code: 'DECISION_SIGNER_UNTRUSTED', status };
  }
  // retired + active (+ vector-only with flag): check validity window vs signedAt

  if (typeof signedAt !== 'number' || !Number.isFinite(signedAt)) {
    return { ok: false, reason: 'missing_fields', code: 'DECISION_SIGNER_UNTRUSTED', detail: 'signedAt required for key window' };
  }

  if (entry.notBefore) {
    const nbf = Math.floor(new Date(entry.notBefore).getTime() / 1000);
    if (Number.isFinite(nbf) && signedAt < nbf) {
      return { ok: false, reason: 'key_not_yet_valid', code: 'DECISION_SIGNER_UNTRUSTED', nbf, signedAt };
    }
  }
  if (entry.notAfter) {
    const until = Math.floor(new Date(entry.notAfter).getTime() / 1000);
    if (Number.isFinite(until) && signedAt > until) {
      return { ok: false, reason: 'key_expired', code: 'DECISION_SIGNER_UNTRUSTED', until, signedAt };
    }
  }
  return { ok: true };
}

async function loadKeys(ref) {
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`keys fetch ${res.status} ${ref}`);
    return { doc: await res.json(), source: ref };
  }
  const body = readFileSync(ref, 'utf8');
  return { doc: JSON.parse(body), source: ref };
}

function parseArgs(argv) {
  const out = {
    path: null,
    keys: DEFAULT_KEYS,
    now: Math.floor(Date.now() / 1000),
    requireValidUntil: false,
    allowVectorOnly: false,
    schema: 'auto',
    mandatePath: null,
    actionPath: null,
    digestSalt: null,
    mandateFlag: false,
    actionFlag: false,
    digestSaltFlag: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keys') out.keys = argv[++i];
    else if (a === '--now') out.now = Number(argv[++i]);
    else if (a === '--require-valid-until') out.requireValidUntil = true;
    else if (a === '--allow-vector-only') out.allowVectorOnly = true;
    else if (a === '--v2') out.schema = 'v2';
    else if (a === '--schema') {
      const value = argv[++i];
      if (!SCHEMA_MODES.has(value)) {
        throw new Error('--schema must be v1, v2, all, or auto');
      }
      out.schema = value;
    } else if (a === '--mandate') {
      out.mandateFlag = true;
      out.mandatePath = argv[++i] ?? '';
    } else if (a === '--action') {
      out.actionFlag = true;
      out.actionPath = argv[++i] ?? '';
    } else if (a === '--digest-salt') {
      out.digestSaltFlag = true;
      out.digestSalt = argv[++i] ?? '';
    }
    else rest.push(a);
  }
  out.path = rest[0] || null;
  return out;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEnvelope(value) {
  return (
    isPlainObject(value) &&
    typeof value.artifactSchema === 'string' &&
    typeof value.canonical === 'string' &&
    typeof value.signature === 'string'
  );
}

const EXPORT_FIELDS = [
  { field: 'signed_export', schema: SCHEMA_V1 },
  { field: 'signed_export_v2', schema: SCHEMA_V2 },
];
const ENVELOPE_MARKERS = ['artifactSchema', 'canonical', 'signature'];

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function selectionError(mode, body) {
  return {
    exitCode: 2,
    error: {
      ok: false,
      verified_schemas: [],
      schema_selection: mode,
      ...body,
    },
  };
}

/**
 * Pick the envelope(s) to verify.
 * Key presence is hasOwnProperty, not truthiness. A present null, string,
 * array or other non-object is invalid. signed_export is v1 only and
 * signed_export_v2 is v2 only. Top-level envelope fields together with
 * signed_export* keys are ambiguous and are not verified.
 */
function selectExports(exp, mode) {
  if (!isPlainObject(exp)) {
    return selectionError(mode, {
      error: 'invalid_export',
      detail: 'input must be a JSON object',
    });
  }

  const exportKeys = EXPORT_FIELDS.filter(({ field }) => hasOwn(exp, field));
  const envelopeMarkers = ENVELOPE_MARKERS.filter((key) => hasOwn(exp, key));
  if (exportKeys.length > 0 && envelopeMarkers.length > 0) {
    return selectionError(mode, {
      error: 'ambiguous_input',
      detail: 'input has both top-level envelope fields and signed_export* keys',
      fields: exportKeys.map(({ field }) => field),
    });
  }

  if (exportKeys.length === 0) {
    if (!isEnvelope(exp)) {
      return selectionError(mode, {
        error: 'missing_fields',
        field: 'signed_export',
        detail: 'no signed_export or signed_export_v2 on response, and input is not an envelope',
      });
    }
    if (mode === 'v1' && exp.artifactSchema !== SCHEMA_V1) {
      return selectionError(mode, {
        error: 'schema_unsupported',
        artifactSchema: exp.artifactSchema,
        detail: 'requested schema v1',
      });
    }
    if (mode === 'v2' && exp.artifactSchema !== SCHEMA_V2) {
      return selectionError(mode, {
        error: 'schema_unsupported',
        artifactSchema: exp.artifactSchema,
        detail: 'requested schema v2',
      });
    }
    return { artifacts: [exp] };
  }

  const wanted = EXPORT_FIELDS.filter(({ field }) => {
    if (mode === 'v1') return field === 'signed_export';
    if (mode === 'v2') return field === 'signed_export_v2';
    return hasOwn(exp, field);
  });

  const artifacts = [];
  for (const { field, schema } of wanted) {
    if (!hasOwn(exp, field)) {
      return selectionError(mode, {
        error: 'missing_fields',
        field,
        detail: `requested schema ${mode}`,
      });
    }
    const value = exp[field];
    if (!isPlainObject(value)) {
      return selectionError(mode, {
        error: 'invalid_export',
        field,
        detail: `${field} is present but not an object`,
      });
    }
    if (value.artifactSchema !== schema) {
      return selectionError(mode, {
        error: 'schema_field_mismatch',
        field,
        artifactSchema: typeof value.artifactSchema === 'string' ? value.artifactSchema : null,
        detail: `${field} must be ${schema}`,
      });
    }
    artifacts.push(value);
  }
  return { artifacts };
}

function fail(exitCode, body) {
  return { exitCode, body };
}

function verifyOne(artifact, args, doc, source) {
  const required = [
    'artifactSchema',
    'verificationId',
    'canonical',
    'digest',
    'keyId',
    'alg',
    'signedAt',
    'signature',
  ];
  for (const k of required) {
    if (artifact[k] === undefined || artifact[k] === null) {
      return fail(2, {
        ok: false,
        error: 'missing_fields',
        field: k,
        artifactSchema: typeof artifact.artifactSchema === 'string' ? artifact.artifactSchema : null,
      });
    }
  }
  if (args.schema === 'v1' && artifact.artifactSchema !== SCHEMA_V1) {
    return fail(2, {
      ok: false,
      error: 'schema_unsupported',
      artifactSchema: artifact.artifactSchema,
      detail: 'requested schema v1',
    });
  }
  if (args.schema === 'v2' && artifact.artifactSchema !== SCHEMA_V2) {
    return fail(2, {
      ok: false,
      error: 'schema_unsupported',
      artifactSchema: artifact.artifactSchema,
      detail: 'requested schema v2',
    });
  }
  if (artifact.alg !== 'Ed25519') {
    return fail(2, {
      ok: false,
      error: 'alg_unsupported',
      alg: artifact.alg,
      artifactSchema: artifact.artifactSchema,
      keyId: artifact.keyId,
    });
  }
  if (!ACCEPTED_ARTIFACT_SCHEMAS.has(artifact.artifactSchema)) {
    return fail(2, {
      ok: false,
      error: 'schema_unsupported',
      artifactSchema: artifact.artifactSchema,
      keyId: artifact.keyId,
    });
  }
  if (!/^0x[0-9a-f]{64}$/.test(artifact.digest)) {
    return fail(2, {
      ok: false,
      error: 'bad_digest_format',
      digest: artifact.digest,
      artifactSchema: artifact.artifactSchema,
      keyId: artifact.keyId,
    });
  }

  const entry = (doc.keys || []).find(
    (k) => k.kid === artifact.keyId || k.keyId === artifact.keyId,
  );
  if (!entry) {
    return fail(3, {
      ok: false,
      error: 'key_not_found',
      code: 'DECISION_SIGNER_UNTRUSTED',
      keyId: artifact.keyId,
      artifactSchema: artifact.artifactSchema,
      keys: source,
    });
  }

  const usable = keyUsable(entry, args.allowVectorOnly, artifact.signedAt);
  if (!usable.ok) {
    return fail(3, {
      ok: false,
      error: usable.reason,
      code: usable.code,
      keyId: artifact.keyId,
      artifactSchema: artifact.artifactSchema,
      status: entry.status || null,
      keys: source,
    });
  }

  let pub;
  try {
    pub = resolvePub(entry);
  } catch (err) {
    return fail(3, {
      ok: false,
      error: 'key_unusable',
      code: 'DECISION_SIGNER_UNTRUSTED',
      detail: err instanceof Error ? err.message : String(err),
      keyId: artifact.keyId,
      artifactSchema: artifact.artifactSchema,
    });
  }

  const fields = {
    artifactSchema: artifact.artifactSchema,
    verificationId: artifact.verificationId,
    canonical: artifact.canonical,
    digest: artifact.digest,
    keyId: artifact.keyId,
    alg: artifact.alg,
    signedAt: artifact.signedAt,
  };
  if (artifact.validUntil !== undefined) fields.validUntil = artifact.validUntil;
  else if (args.requireValidUntil) {
    return fail(2, {
      ok: false,
      error: 'validUntil_required',
      artifactSchema: artifact.artifactSchema,
      keyId: artifact.keyId,
    });
  }

  const sigHex = String(artifact.signature).replace(/^0x/i, '');
  const signedInput = buildSignedInput(fields);
  const sigOk = cryptoVerify(null, signedInput, pub, Buffer.from(sigHex, 'hex'));
  if (!sigOk) {
    return fail(5, {
      ok: false,
      error: 'signature_invalid',
      code: 'DECISION_SIGNATURE_INVALID',
      keyId: artifact.keyId,
      artifactSchema: artifact.artifactSchema,
      keys: source,
      note: 'Canonical/envelope bytes changed after signing, or wrong key material for this kid — not an unpinned-signer class',
    });
  }

  const recomputed = digestCanonical(artifact.canonical);
  if (recomputed !== artifact.digest) {
    return fail(4, {
      ok: false,
      error: 'digest_mismatch',
      code: 'DECISION_COMMITMENT_DIGEST_MISMATCH',
      digest: artifact.digest,
      recomputedDigest: recomputed,
      artifactSchema: artifact.artifactSchema,
      keyId: artifact.keyId,
      note: 'Verify against transported canonical string of the issued artifact — never a fresh /sentinel/verify',
    });
  }

  if (fields.validUntil !== undefined && args.now > fields.validUntil) {
    return fail(6, {
      ok: false,
      error: 'expired',
      now: args.now,
      validUntil: fields.validUntil,
      keyId: artifact.keyId,
      artifactSchema: artifact.artifactSchema,
    });
  }

  return {
    exitCode: 0,
    body: {
      ok: true,
      artifactSchema: artifact.artifactSchema,
      keyId: artifact.keyId,
      keyStatus: entry.status || 'active',
      verificationId: artifact.verificationId,
      digest: artifact.digest,
      recomputedDigest: recomputed,
      signedAt: artifact.signedAt,
      validUntil: fields.validUntil ?? null,
      keys: source,
      domain: DOMAIN,
      envelopeAlg: artifact.alg,
      jwkAlg: entry.alg || null,
      verifyOrder: 'key_resolve → signature → digest → validUntil',
      note: 'envelope alg Ed25519 ≠ JWK alg EdDSA — do not cross-compare',
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.path) {
    console.error(
      'Usage: node scripts/verify-canonical-export.mjs <export.json> [--keys path|url] [--now unix] [--require-valid-until] [--allow-vector-only] [--schema v1|v2|all|auto] [--v2] [--mandate file.json] [--action file.json] [--digest-salt hex]',
    );
    process.exit(1);
  }
  const exp = JSON.parse(readFileSync(args.path, 'utf8'));
  const selected = selectExports(exp, args.schema);
  if (selected.error) {
    console.log(JSON.stringify(selected.error, null, 2));
    process.exit(selected.exitCode);
  }

  const { doc, source } = await loadKeys(args.keys);
  const outcomes = selected.artifacts.map((artifact) => verifyOne(artifact, args, doc, source));
  const verifiedSchemas = outcomes.filter((item) => item.body.ok).map((item) => item.body.artifactSchema);
  const failed = outcomes.find((item) => !item.body.ok);

  if (!failed) {
    const commitment = checkSaltedCommitments(selected.artifacts, args);
    if (commitment && commitment.ok === false) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: commitment.error,
            field: commitment.field ?? null,
            detail: commitment.detail ?? null,
            code: commitment.code ?? 'DECISION_COMMITMENT_DIGEST_MISMATCH',
            verified_schemas: verifiedSchemas,
            schema_selection: args.schema,
          },
          null,
          2,
        ),
      );
      process.exit(commitment.exitCode);
    }
    const commitmentCheck = commitment
      ? { commitment_check: { ok: true, fields: commitment.fields } }
      : {};
    if (outcomes.length === 1) {
      console.log(
        JSON.stringify(
          {
            ...outcomes[0].body,
            ...commitmentCheck,
            verified_schemas: verifiedSchemas,
            schema_selection: args.schema,
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          ...commitmentCheck,
          verified_schemas: verifiedSchemas,
          schema_selection: args.schema,
          results: outcomes.map((item) => item.body),
          keys: source,
          domain: DOMAIN,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  console.log(
    JSON.stringify(
      {
        ...failed.body,
        verified_schemas: verifiedSchemas,
        failed_schema: failed.body.artifactSchema ?? null,
        schema_selection: args.schema,
        results: outcomes.map((item) => item.body),
      },
      null,
      2,
    ),
  );
  process.exit(failed.exitCode);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(10);
  });
}
