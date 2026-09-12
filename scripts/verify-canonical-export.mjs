#!/usr/bin/env node
/**
 * Portable verifier for ThoughtProof Sentinel M1 signed canonical exports.
 *
 * Zero repo dependency beyond Node 18+ (uses built-in crypto only).
 * JCS for the *envelope* signed fields uses a minimal RFC 8785-compatible
 * sort+serialize that matches `canonicalize` for the flat export field set
 * (string/number only, no floats that need es6 number formatting edge cases
 * beyond integers we emit).
 *
 *   node scripts/verify-canonical-export.mjs <export.json> \
 *     [--keys path-or-url] [--now unix] [--require-valid-until]
 *
 * Default keys URL:
 *   https://sentinel.thoughtproof.ai/.well-known/thoughtproof-keys.json
 *
 * Verification order (M1 contract):
 *   1. pin keyId → public key
 *   2. Ed25519 verify domain||0x00||JCS(fields)
 *   3. sha256(UTF-8(transported canonical string)) === digest
 *   4. optional validUntil vs --now
 */
import {
  createPublicKey,
  createHash,
  verify as cryptoVerify,
} from 'crypto';
import { readFileSync, existsSync } from 'fs';
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

function resolvePub(entry) {
  if (entry.publicKeyPem) return createPublicKey(entry.publicKeyPem);
  if (entry.publicKey && /^[0-9a-fA-F]{64}$/.test(entry.publicKey)) {
    const raw = Buffer.from(entry.publicKey, 'hex');
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      raw,
    ]);
    return createPublicKey({ key: spki, format: 'der', type: 'spki' });
  }
  throw new Error('key entry missing publicKeyPem/publicKey');
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
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keys') out.keys = argv[++i];
    else if (a === '--now') out.now = Number(argv[++i]);
    else if (a === '--require-valid-until') out.requireValidUntil = true;
    else rest.push(a);
  }
  out.path = rest[0] || null;
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.path) {
    console.error(
      'Usage: node scripts/verify-canonical-export.mjs <export.json> [--keys path|url] [--now unix] [--require-valid-until]',
    );
    process.exit(1);
  }
  const exp = JSON.parse(readFileSync(args.path, 'utf8'));
  // Allow full verify response with signed_export nested
  const artifact = exp.signed_export && typeof exp.signed_export === 'object' ? exp.signed_export : exp;

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
    (k) => (k.kid === artifact.keyId || k.keyId === artifact.keyId) && k.status !== 'retired',
  );
  if (!entry) {
    console.log(
      JSON.stringify({ ok: false, error: 'key_not_found', keyId: artifact.keyId, keys: source }, null, 2),
    );
    process.exit(3);
  }
  if (entry.notAfter) {
    const until = Math.floor(new Date(entry.notAfter).getTime() / 1000);
    if (Number.isFinite(until) && args.now > until) {
      console.log(JSON.stringify({ ok: false, error: 'key_expired', keyId: artifact.keyId }, null, 2));
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

  const pub = resolvePub(entry);
  const sigHex = String(artifact.signature).replace(/^0x/i, '');
  const sigOk = cryptoVerify(
    null,
    buildSignedInput(fields),
    pub,
    Buffer.from(sigHex, 'hex'),
  );
  if (!sigOk) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: 'signature_invalid',
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
        verificationId: artifact.verificationId,
        digest: artifact.digest,
        recomputedDigest: recomputed,
        signedAt: artifact.signedAt,
        validUntil: fields.validUntil ?? null,
        keys: source,
        domain: DOMAIN,
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
