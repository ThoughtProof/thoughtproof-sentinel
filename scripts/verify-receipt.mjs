#!/usr/bin/env node
/**
 * Portable Receipt Verifier (F1 package_digest + F5 offline ed25519)
 * ------------------------------------------------------------------
 *
 * Offline checks for ThoughtProof Sentinel receipts:
 *  1. Recompute package_digest from the original request (F1)
 *  2. Recompute ed25519 over signed_evidence[i].raw_event (F5)
 *     using caller-supplied trusted public keys — never trust
 *     server-emitted evidence_verification[].status
 *
 * Usage:
 *   node scripts/verify-receipt.mjs <receipt.json> [original-request.json] \
 *     [--trusted-pubkey <hex>]... \
 *     [--trusted-key <key_id>=<hex>]...
 *
 * Exit codes:
 *   0 — all requested checks passed
 *   1 — verification failed (digest mismatch, bad/missing sig, unknown key, …)
 *   2 — usage / load error
 *
 * JCS for signatures uses the same `canonicalize` package as the server
 * (src/signed-evidence.ts). Rationale: byte-identical signed material is
 * required; a second JCS implementation would be a silent security footgun.
 * Install deps from this repo (`npm i`) before running signature checks.
 */

import { readFileSync, existsSync } from 'fs';
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadCanonicalize() {
  const candidates = [
    () => require('canonicalize'),
    () => require(join(__dirname, '..', 'node_modules', 'canonicalize')),
  ];
  for (const load of candidates) {
    try {
      const mod = load();
      return typeof mod === 'function' ? mod : mod?.default;
    } catch {
      // try next
    }
  }
  return null;
}

const canonicalize = loadCanonicalize();

// ─── CLI parsing ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const positionals = [];
  /** @type {Map<string, string>} key_id -> pubkey hex (lowercase) */
  const trusted = new Map();
  /** bare pubkeys without id (matched by hex equality) */
  const barePubkeys = new Set();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--trusted-pubkey' || a === '--pubkey') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} requires a hex value`);
      const hex = normalizeHex(v);
      barePubkeys.add(hex);
      trusted.set(hex, hex); // allow matching by pubkey as key_id
    } else if (a === '--trusted-key') {
      const v = argv[++i];
      if (!v || !v.includes('=')) {
        throw new Error('--trusted-key requires key_id=<hex>');
      }
      const eq = v.indexOf('=');
      const id = v.slice(0, eq).trim();
      const hex = normalizeHex(v.slice(eq + 1));
      if (!id) throw new Error('--trusted-key key_id must be non-empty');
      trusted.set(id.toLowerCase(), hex);
      barePubkeys.add(hex);
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else if (a.startsWith('-')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      positionals.push(a);
    }
  }

  return {
    receiptPath: positionals[0],
    requestPath: positionals[1],
    trusted,
    barePubkeys,
  };
}

function normalizeHex(v) {
  const hex = String(v).trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length !== 64) {
    throw new Error(`Ed25519 public key must be 64 hex chars, got length ${hex.length}`);
  }
  return hex;
}

function printUsage() {
  console.log(`Usage:
  node scripts/verify-receipt.mjs <receipt.json> [original-request.json] \\
    [--trusted-pubkey <hex>]... \\
    [--trusted-key <key_id>=<hex>]...

F1  package_digest  — requires original-request.json
F5  offline ed25519 — requires original-request.json + at least one trusted key

Exit 0 = pass, 1 = verify fail, 2 = usage/load error.
Never trusts receipt.meta.evidence_verification[].status.`);
}

// ─── Package digest (F1) — same algorithm as src/package-digest.ts ───

function computePackageDigest(request) {
  if (!canonicalize) {
    throw new Error(
      'canonicalize package not found. Run `npm i` in thoughtproof-sentinel so package_digest matches the server.',
    );
  }
  const clean = removeUndefinedFields(request);
  const canonical = canonicalize(clean);
  if (typeof canonical !== 'string') {
    throw new Error('canonicalize() did not return a string');
  }
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

function removeUndefinedFields(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(removeUndefinedFields);
  if (typeof obj === 'object') {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) cleaned[key] = removeUndefinedFields(value);
    }
    return cleaned;
  }
  return obj;
}

// ─── Ed25519 (F5) — same path as src/signed-evidence.ts ──────────────

function canonicalizePayload(payload) {
  if (!canonicalize) {
    throw new Error(
      'canonicalize package not found. Run `npm i` in thoughtproof-sentinel so ed25519 JCS matches the server.',
    );
  }
  const canonicalJson = canonicalize(payload);
  if (typeof canonicalJson !== 'string') {
    throw new Error('canonicalize() did not return a string');
  }
  return Buffer.from(canonicalJson, 'utf8');
}

function verifyEd25519Signature(message, signature, publicKeyHex) {
  try {
    const pubKeyBuffer = Buffer.from(publicKeyHex, 'hex');
    if (pubKeyBuffer.length !== 32) return false;

    // DER-encoded SubjectPublicKeyInfo for Ed25519 (OID 1.3.101.112)
    const derHeader = Buffer.from([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ]);
    const derEncoded = Buffer.concat([derHeader, pubKeyBuffer]);
    const pem = [
      '-----BEGIN PUBLIC KEY-----',
      derEncoded.toString('base64').match(/.{1,64}/g)?.join('\n') || derEncoded.toString('base64'),
      '-----END PUBLIC KEY-----',
    ].join('\n');

    const publicKey = createPublicKey(pem);
    const signatureBuffer = Buffer.from(String(signature).replace(/^0x/, ''), 'hex');
    return cryptoVerify(null, message, publicKey, signatureBuffer);
  } catch {
    return false;
  }
}

/**
 * Resolve whether a signer_pubkey is in the caller-supplied trust set.
 * key_id matching is optional via --trusted-key; bare --trusted-pubkey matches hex.
 */
function isTrustedPubkey(signerPubkey, trusted, barePubkeys) {
  const hex = String(signerPubkey || '').replace(/^0x/i, '').toLowerCase();
  if (barePubkeys.has(hex)) return true;
  // also allow key_id that equals pubkey
  if (trusted.has(hex)) return true;
  return false;
}

/**
 * Offline recompute one signed_evidence item.
 * Does NOT read evidence_verification status from the receipt.
 */
function recomputeEvidenceItem(item, index, trusted, barePubkeys) {
  const base = { index, signer: item?.signer_pubkey ?? null };

  if (!item || typeof item !== 'object') {
    return { ...base, status: 'failed', code: 'evidence_malformed', reason: 'Missing evidence item' };
  }
  if (item.type !== 'signed_event') {
    return { ...base, status: 'failed', code: 'unsupported_evidence_type', reason: `type=${item.type}` };
  }
  if (item.signature_scheme !== 'ed25519') {
    return {
      ...base,
      status: 'failed',
      code: 'unsupported_signature_scheme',
      reason: `scheme=${item.signature_scheme}`,
    };
  }
  if (typeof item.raw_event !== 'string' || !item.raw_event) {
    return { ...base, status: 'failed', code: 'evidence_malformed', reason: 'Missing raw_event' };
  }
  if (typeof item.signer_pubkey !== 'string') {
    return { ...base, status: 'failed', code: 'evidence_malformed', reason: 'Missing signer_pubkey' };
  }

  const signerHex = item.signer_pubkey.replace(/^0x/i, '').toLowerCase();
  if (!isTrustedPubkey(signerHex, trusted, barePubkeys)) {
    return {
      ...base,
      signer: signerHex,
      status: 'failed',
      code: 'untrusted_signer',
      reason: 'signer_pubkey not in --trusted-pubkey / --trusted-key set',
    };
  }

  let rawEvent;
  try {
    const eventBytes = Buffer.from(item.raw_event, 'base64');
    rawEvent = JSON.parse(eventBytes.toString('utf8'));
  } catch {
    return {
      ...base,
      signer: signerHex,
      status: 'failed',
      code: 'evidence_malformed',
      reason: 'raw_event is not valid base64 JSON',
    };
  }

  if (!rawEvent || typeof rawEvent !== 'object' || !rawEvent.payload || typeof rawEvent.signature !== 'string') {
    return {
      ...base,
      signer: signerHex,
      status: 'failed',
      code: 'evidence_malformed',
      reason: 'raw_event missing payload or signature',
    };
  }

  let canonicalPayload;
  try {
    canonicalPayload = canonicalizePayload(rawEvent.payload);
  } catch (err) {
    return {
      ...base,
      signer: signerHex,
      status: 'failed',
      code: 'evidence_malformed',
      reason: `canonicalize failed: ${err.message}`,
    };
  }

  // IMPORTANT: verify against the trusted key set entry that matches signer,
  // not a different key the caller might have also supplied.
  const sigOk = verifyEd25519Signature(canonicalPayload, rawEvent.signature, signerHex);
  if (!sigOk) {
    return {
      ...base,
      signer: signerHex,
      status: 'failed',
      code: 'evidence_signature_invalid',
      reason: 'Invalid ed25519 signature over JCS-canonical payload',
    };
  }

  return {
    ...base,
    signer: signerHex,
    status: 'recomputed',
    code: null,
    reason: null,
    claims: Array.isArray(item.claims) ? item.claims : [],
  };
}

// ─── Reporting ───────────────────────────────────────────────────────

function printHeader(receipt) {
  console.log(`Verification ID: ${receipt.id ?? '(none)'}`);
  console.log(`Verdict: ${receipt.verdict ?? '(none)'}`);
  console.log(`Confidence: ${receipt.confidence ?? '(none)'}`);
  console.log(`Tier: ${receipt.tier ?? '(none)'}`);
  console.log(`Mode: ${receipt.mode ?? '(none)'}`);
}

function verifyDigest(receipt, request) {
  console.log('\n=== F1 Package Digest (offline recompute) ===');
  const expected = receipt.meta?.package_digest;
  if (!expected) {
    console.log('❌ No package_digest in receipt');
    return false;
  }
  if (!String(expected).startsWith('sha256:')) {
    console.log('❌ Invalid digest format (expected sha256:...)');
    return false;
  }
  try {
    const computed = computePackageDigest(request);
    const match = computed === expected;
    console.log(`Expected: ${expected}`);
    console.log(`Computed: ${computed}`);
    console.log(`${match ? '✅' : '❌'} package_digest ${match ? 'matches' : 'MISMATCH'}`);
    return match;
  } catch (err) {
    console.log(`❌ Failed to compute package_digest: ${err.message}`);
    return false;
  }
}

function verifyEvidenceOffline(request, trusted, barePubkeys) {
  console.log('\n=== F5 Offline ed25519 (caller-trusted keys only) ===');
  console.log('Note: server evidence_verification[].status is NOT trusted.');

  const items = request.signed_evidence;
  if (!Array.isArray(items) || items.length === 0) {
    console.log('ℹ️  No signed_evidence in original request — nothing to recompute.');
    return { ok: true, results: [], hadEvidence: false };
  }

  if (trusted.size === 0 && barePubkeys.size === 0) {
    console.log('❌ signed_evidence present but no --trusted-pubkey / --trusted-key supplied');
    console.log('   Refusing to treat server status as proof.');
    return { ok: false, results: [], hadEvidence: true, missingTrust: true };
  }

  const results = items.map((item, i) => recomputeEvidenceItem(item, i, trusted, barePubkeys));
  let allOk = true;
  for (const r of results) {
    const mark = r.status === 'recomputed' ? '✅' : '❌';
    console.log(`${mark} [${r.index}] status=${r.status}${r.code ? ` code=${r.code}` : ''}`);
    if (r.signer) console.log(`      signer: ${r.signer}`);
    if (r.reason) console.log(`      reason: ${r.reason}`);
    if (r.status !== 'recomputed') allOk = false;
  }
  return { ok: allOk, results, hadEvidence: true };
}

function crossCheckServerClaims(receipt, offlineResults) {
  // Informational only: show where server claim diverges from offline result.
  const server = receipt.meta?.evidence_verification;
  if (!Array.isArray(server) || server.length === 0 || offlineResults.length === 0) return;

  console.log('\n=== Server claim vs offline (informational) ===');
  for (const r of offlineResults) {
    const s = server.find((x) => x.index === r.index) || server[r.index];
    const serverStatus = s?.status ?? '(absent)';
    if (serverStatus !== r.status) {
      console.log(
        `⚠️  [${r.index}] server claimed status="${serverStatus}" but offline=${r.status}` +
          (r.code ? ` (${r.code})` : ''),
      );
    } else {
      console.log(`   [${r.index}] server="${serverStatus}" offline="${r.status}" (agree)`);
    }
  }
}

// ─── main ────────────────────────────────────────────────────────────

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    printUsage();
    process.exit(2);
  }

  if (!args.receiptPath) {
    printUsage();
    process.exit(2);
  }

  let receipt;
  try {
    receipt = JSON.parse(readFileSync(args.receiptPath, 'utf8'));
  } catch (err) {
    console.error(`Error loading receipt: ${err.message}`);
    process.exit(2);
  }

  printHeader(receipt);

  let request = null;
  if (args.requestPath) {
    try {
      request = JSON.parse(readFileSync(args.requestPath, 'utf8'));
    } catch (err) {
      console.error(`Error loading request: ${err.message}`);
      process.exit(2);
    }
  }

  let digestOk = true;
  let evidenceOk = true;
  let offlineResults = [];

  if (request) {
    digestOk = verifyDigest(receipt, request);
    const ev = verifyEvidenceOffline(request, args.trusted, args.barePubkeys);
    evidenceOk = ev.ok;
    offlineResults = ev.results;
    crossCheckServerClaims(receipt, offlineResults);
  } else {
    console.log('\n💡 Provide original-request.json for F1 digest + F5 signature checks.');
    console.log('   Without it, this script cannot recompute anything offline.');
    // If receipt claims recomputed evidence but we cannot check → fail closed
    const claims = receipt.meta?.evidence_verification;
    if (Array.isArray(claims) && claims.length > 0) {
      console.log('❌ Receipt claims evidence_verification but no request provided — fail closed.');
      evidenceOk = false;
    }
  }

  console.log('\n=== Overall ===');
  console.log(`${digestOk ? '✅' : '❌'} package_digest`);
  console.log(`${evidenceOk ? '✅' : '❌'} offline ed25519 / evidence`);

  // Fail closed: never exit 0 based on server-emitted evidence status alone.
  const allGood = digestOk && evidenceOk;
  process.exit(allGood ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error(`Fatal: ${err.message}`);
  process.exit(2);
}
