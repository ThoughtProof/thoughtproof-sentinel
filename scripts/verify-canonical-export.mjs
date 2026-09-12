#!/usr/bin/env node
/**
 * Portable verifier for ThoughtProof Sentinel M1 signed canonical exports.
 *
 * Zero repo dependency beyond Node 18+ (built-in crypto only).
 *
 *   node scripts/verify-canonical-export.mjs <export.json> \
 *     [--keys path-or-url] [--now unix] [--require-valid-until] \
 *     [--allow-vector-only]
 *
 * Default keys URL:
 *   https://sentinel.thoughtproof.ai/.well-known/thoughtproof-keys.json
 *
 * Key document: thoughtproof.keys.v1 (OKP + TP status extensions) — not pure JWKS.
 * JWK alg = EdDSA (JOSE). Envelope alg = Ed25519. Do not cross-compare them.
 *
 * Verification order (M1 contract):
 *   1. resolve keyId → OKP key; reject retired / vector-only (unless flag)
 *   2. Ed25519 verify domain||0x00||JCS(fields)
 *   3. sha256(UTF-8(transported canonical string)) === digest
 *   4. optional validUntil vs --now
 */
import {
  createPublicKey,
  createHash,
  verify as cryptoVerify,
} from 'crypto';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

const DOMAIN = 'thoughtproof.sentinel.export.v1';
const DEFAULT_KEYS =
  process.env.THOUGHTPROOF_KEYS_URL ||
  'https://sentinel.thoughtproof.ai/.well-known/thoughtproof-keys.json';

/** Minimal JCS for flat objects with string/int values (export signed fields). */
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
 * Resolve public key from a thoughtproof.keys.v1 entry.
 * Preferred: OKP JWK { kty, crv, x }. Legacy PEM/hex accepted during transition.
 */
function resolvePub(entry) {
  if (entry.kty === 'OKP' && entry.crv === 'Ed25519' && typeof entry.x === 'string') {
    return createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: entry.x,
      },
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

/** status extensions: only `active` is production-trustworthy. */
function keyUsable(entry, allowVectorOnly) {
  const status = entry.status || 'active';
  if (status === 'retired') {
    return { ok: false, reason: 'key_retired' };
  }
  if (status === 'vector-only') {
    if (allowVectorOnly) return { ok: true };
    return { ok: false, reason: 'vector_only_key_not_allowed' };
  }
  if (status === 'active') return { ok: true };
  return { ok: false, reason: 'key_status_unusable', status };
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
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keys') out.keys = argv[++i];
    else if (a === '--now') out.now = Number(argv[++i]);
    else if (a === '--require-valid-until') out.requireValidUntil = true;
    else if (a === '--allow-vector-only') out.allowVectorOnly = true;
    else rest.push(a);
  }
  out.path = rest[0] || null;
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.path) {
    console.error(
      'Usage: node scripts/verify-canonical-export.mjs <export.json> [--keys path|url] [--now unix] [--require-valid-until] [--allow-vector-only]',
    );
    process.exit(1);
  }
  const exp = JSON.parse(readFileSync(args.path, 'utf8'));
  const artifact =
    exp.signed_export && typeof exp.signed_export === 'object' ? exp.signed_export : exp;

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
      console.log(JSON.stringify({ ok: false, error: 'missing_fields', field: k }, null, 2));
      process.exit(2);
    }
  }
  // Envelope alg is Ed25519 (primitive). Do not require equality with JWK alg EdDSA.
  if (artifact.alg !== 'Ed25519') {
    console.log(JSON.stringify({ ok: false, error: 'alg_unsupported', alg: artifact.alg }, null, 2));
    process.exit(2);
  }

  const recomputed = digestCanonical(artifact.canonical);
  if (recomputed !== artifact.digest) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: 'digest_mismatch',
          code: 'DECISION_COMMITMENT_DIGEST_MISMATCH',
          digest: artifact.digest,
          recomputedDigest: recomputed,
          note: 'Verify against transported canonical string of the issued artifact — never a fresh /sentinel/verify',
        },
        null,
        2,
      ),
    );
    process.exit(4);
  }

  const { doc, source } = await loadKeys(args.keys);
  const entry = (doc.keys || []).find(
    (k) => k.kid === artifact.keyId || k.keyId === artifact.keyId,
  );
  if (!entry) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: 'key_not_found',
          code: 'DECISION_SIGNER_UNTRUSTED',
          keyId: artifact.keyId,
          keys: source,
        },
        null,
        2,
      ),
    );
    process.exit(3);
  }

  const usable = keyUsable(entry, args.allowVectorOnly);
  if (!usable.ok) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: usable.reason,
          code: 'DECISION_SIGNER_UNTRUSTED',
          keyId: artifact.keyId,
          status: entry.status || null,
          keys: source,
        },
        null,
        2,
      ),
    );
    process.exit(3);
  }

  if (entry.notAfter) {
    const until = Math.floor(new Date(entry.notAfter).getTime() / 1000);
    if (Number.isFinite(until) && args.now > until) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: 'key_expired',
            code: 'DECISION_SIGNER_UNTRUSTED',
            keyId: artifact.keyId,
          },
          null,
          2,
        ),
      );
      process.exit(3);
    }
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
    console.log(JSON.stringify({ ok: false, error: 'validUntil_required' }, null, 2));
    process.exit(2);
  }

  let pub;
  try {
    pub = resolvePub(entry);
  } catch (err) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: 'key_unusable',
          detail: err instanceof Error ? err.message : String(err),
          keyId: artifact.keyId,
        },
        null,
        2,
      ),
    );
    process.exit(3);
  }

  const sigHex = String(artifact.signature).replace(/^0x/i, '');
  const signedInput = buildSignedInput(fields);
  const sigOk = cryptoVerify(null, signedInput, pub, Buffer.from(sigHex, 'hex'));
  if (!sigOk) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: 'signature_invalid',
          code: 'DECISION_SIGNER_UNTRUSTED',
          keyId: artifact.keyId,
          keys: source,
          recomputedDigest: recomputed,
        },
        null,
        2,
      ),
    );
    process.exit(5);
  }

  if (fields.validUntil !== undefined && args.now > fields.validUntil) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: 'expired',
          now: args.now,
          validUntil: fields.validUntil,
          keyId: artifact.keyId,
        },
        null,
        2,
      ),
    );
    process.exit(6);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
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
        note: 'envelope alg Ed25519 ≠ JWK alg EdDSA — do not cross-compare',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(10);
  });
}
