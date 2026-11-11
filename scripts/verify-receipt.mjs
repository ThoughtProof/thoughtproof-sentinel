#!/usr/bin/env node
/**
 * Portable Receipt Verifier (F1 package_digest + F5 offline ed25519)
 * ------------------------------------------------------------------
 *
 * Offline checks for ThoughtProof Sentinel receipts:
 *  1. Recompute package_digest from the original request (F1)
 *  2. Recompute ed25519 over the JCS-canonical payload inside
 *     signed_evidence[i].raw_event (F5) using caller-supplied trusted
 *     public keys — never trust server-emitted evidence_verification[].status
 *  3. Action-binding: the same checkActionBinding predicate as the server
 *     (src/action-binding-core.mjs). Signature, binding, and authority are
 *     separate statuses. Authority here is the caller-supplied trusted key,
 *     not the inline key manifest.
 *
 * Each evidence item prints one stable line:
 *   PORTABLE_ITEM {"index":0,"status":"recomputed","code":null,
 *     "signature":{"status":"passed","code":null},
 *     "binding":{"status":"passed"|"failed"|"not_checked","code":...},
 *     "authority":{"status":"passed"|"failed"|"not_checked","code":...}}
 * `not_checked` means that stage did not run. A recognised approval that
 * fails signature, binding, or authority makes the process exit 1.
 * Duplicate keys in raw_event JSON fail first, with code duplicate_json_key,
 * using src/json-duplicate-keys.mjs (the same parser as the server).
 * Evidence that is not an approval leaves binding `not_checked` and keeps
 * the previous exit code.
 * After a signature and binding pass, signed payload `claims` are checked
 * with src/signed-claims.mjs (the same function as the server). A bad shape
 * is signed_claims_malformed and exits 1.
 * `authority: passed` means the signer matched a CLI trust anchor. It does
 * not mean the inline key manifest was checked. With no trusted key, the
 * process still exits 1 and every item still prints PORTABLE_ITEM. Authority
 * is failed when the signer can be read, and not_checked when the item fails
 * before that stage.
 *
 * Usage:
 *   node scripts/verify-receipt.mjs <receipt.json> <original-request.json> \
 *     [--trusted-pubkey <hex>]... \
 *     [--trusted-key <key_id>=<hex>]...
 *
 * Both positionals are required (fail closed).
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

import { readFileSync } from 'fs';
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { checkActionBinding } from '../src/action-binding-core.mjs';
import { DUPLICATE_JSON_KEY, parseJsonText } from '../src/json-duplicate-keys.mjs';
import { readSignedClaims } from '../src/signed-claims.mjs';

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
  const trustedById = new Map();
  /** bare pubkeys from --trusted-pubkey (matched by signer_pubkey hex only) */
  const barePubkeys = new Set();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--trusted-pubkey' || a === '--pubkey') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} requires a hex value`);
      barePubkeys.add(normalizeHex(v));
    } else if (a === '--trusted-key') {
      const v = argv[++i];
      if (!v || !v.includes('=')) {
        throw new Error('--trusted-key requires key_id=<hex>');
      }
      const eq = v.indexOf('=');
      const id = v.slice(0, eq).trim();
      const hex = normalizeHex(v.slice(eq + 1));
      if (!id) throw new Error('--trusted-key key_id must be non-empty');
      // Bind by key_id only — do NOT also accept this pubkey as a bare match.
      trustedById.set(id.toLowerCase(), hex);
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
    trustedById,
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
  node scripts/verify-receipt.mjs <receipt.json> <original-request.json> \\
    [--trusted-pubkey <hex>]... \\
    [--trusted-key <key_id>=<hex>]...

Both positionals are required for offline verification (fail closed).

F1  package_digest  — recomputed from original-request.json
F5  offline ed25519 — over JCS-canonical payload inside raw_event
    --trusted-pubkey matches item.signer_pubkey hex
    --trusted-key binds key_id → pubkey; item must declare that key_id
      (item.key_id | item.key_manifest_ref | raw_event.key_id) and
      item.signer_pubkey must equal the bound pubkey
    Action-binding uses the same predicate as the server. A recognised
    approval fails the process when signature, binding, or the trusted-key
    authority check fails. Other evidence leaves binding not_checked.

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

// Must match removeUndefinedFields in src/package-digest.ts.
// Assigning onto {} drops an own "__proto__" key via the prototype setter.
function removeUndefinedFields(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(removeUndefinedFields);
  if (typeof obj === 'object') {
    const cleaned = Object.create(null);
    for (const key of Object.keys(obj)) {
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) continue;
      if (desc.value === undefined) continue;
      Object.defineProperty(cleaned, key, {
        value: removeUndefinedFields(desc.value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
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
 * Resolve trusted pubkey for an evidence item.
 *
 * - --trusted-pubkey: accept if item.signer_pubkey is in barePubkeys
 * - --trusted-key id=hex: require item to declare key_id equal to id, AND
 *   item.signer_pubkey must equal the bound hex
 *
 * Declared key_id sources (first match wins):
 *   item.key_id | item.key_manifest_ref | raw_event.key_id | raw_event.payload.key_id
 */
function resolveTrustedKey(item, rawEvent, trustedById, barePubkeys) {
  const signerHex = String(item?.signer_pubkey || '').replace(/^0x/i, '').toLowerCase();
  if (!signerHex || !/^[0-9a-f]{64}$/.test(signerHex)) {
    return { ok: false, pubkey: null, code: 'evidence_malformed', reason: 'Missing/invalid signer_pubkey' };
  }

  const declaredId = [
    item?.key_id,
    item?.key_manifest_ref,
    rawEvent?.key_id,
    rawEvent?.payload && typeof rawEvent.payload === 'object' ? rawEvent.payload.key_id : null,
  ]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => String(v).trim().toLowerCase())[0] || null;

  // Prefer explicit key_id binding when declared and present in trustedById
  if (declaredId && trustedById.has(declaredId)) {
    const expected = trustedById.get(declaredId);
    if (expected !== signerHex) {
      return {
        ok: false,
        pubkey: signerHex,
        code: 'key_id_pubkey_mismatch',
        reason: `key_id=${declaredId} is bound to a different pubkey than signer_pubkey`,
      };
    }
    return { ok: true, pubkey: signerHex, code: null, reason: null };
  }

  // Bare pubkey trust (--trusted-pubkey only)
  if (barePubkeys.has(signerHex)) {
    return { ok: true, pubkey: signerHex, code: null, reason: null };
  }

  if (declaredId && trustedById.size > 0) {
    return {
      ok: false,
      pubkey: signerHex,
      code: 'untrusted_key_id',
      reason: `key_id=${declaredId} not in --trusted-key set`,
    };
  }

  return {
    ok: false,
    pubkey: signerHex,
    code: 'untrusted_signer',
    reason: 'signer_pubkey not in --trusted-pubkey set (and no matching --trusted-key id on item)',
  };
}

function stage(status, code = null) {
  return { status, code };
}

const STAGE_NOT_CHECKED = stage('not_checked');
const STAGE_PASSED = stage('passed');

/** Present only when the request object actually has the property. Same rule as the server. */
function proposedActionSource(request) {
  if (
    request &&
    typeof request === 'object' &&
    !Array.isArray(request) &&
    Object.prototype.hasOwnProperty.call(request, 'proposed_action')
  ) {
    return { present: true, value: request.proposed_action };
  }
  return { present: false, value: undefined };
}

function withChecks(result, checks) {
  return { ...result, checks };
}

/**
 * Offline recompute one signed_evidence item.
 * Does NOT read evidence_verification status from the receipt.
 * Signature is over JCS-canonical payload inside raw_event (same as server).
 *
 * Authority is the caller-supplied trusted key. It is decided before the
 * signature so an untrusted legacy item still fails with the existing
 * authority code. Binding runs only after the signature verifies, and it
 * calls the shared server predicate. A binding miss fails the item. Evidence
 * that is not an approval leaves binding not_checked.
 */
function recomputeEvidenceItem(item, index, trustedById, barePubkeys, proposedAction) {
  const base = { index, signer: item?.signer_pubkey ?? null };
  const unchecked = {
    signature: STAGE_NOT_CHECKED,
    binding: STAGE_NOT_CHECKED,
    authority: STAGE_NOT_CHECKED,
  };

  if (!item || typeof item !== 'object') {
    return withChecks(
      { ...base, status: 'failed', code: 'evidence_malformed', reason: 'Missing evidence item' },
      unchecked,
    );
  }
  if (item.type !== 'signed_event') {
    return withChecks(
      { ...base, status: 'failed', code: 'unsupported_evidence_type', reason: `type=${item.type}` },
      unchecked,
    );
  }
  if (item.signature_scheme !== 'ed25519') {
    return withChecks(
      {
        ...base,
        status: 'failed',
        code: 'unsupported_signature_scheme',
        reason: `scheme=${item.signature_scheme}`,
      },
      unchecked,
    );
  }
  if (typeof item.raw_event !== 'string' || !item.raw_event) {
    return withChecks(
      { ...base, status: 'failed', code: 'evidence_malformed', reason: 'Missing raw_event' },
      unchecked,
    );
  }
  if (typeof item.signer_pubkey !== 'string') {
    return withChecks(
      { ...base, status: 'failed', code: 'evidence_malformed', reason: 'Missing signer_pubkey' },
      unchecked,
    );
  }

  let rawEvent;
  try {
    const eventBytes = Buffer.from(item.raw_event, 'base64');
    const parsed = parseJsonText(eventBytes.toString('utf8'));
    if (!parsed.ok && parsed.code === DUPLICATE_JSON_KEY) {
      return withChecks(
        {
          ...base,
          status: 'failed',
          code: DUPLICATE_JSON_KEY,
          reason: 'Signed JSON contains a duplicate key',
        },
        unchecked,
      );
    }
    if (!parsed.ok) {
      return withChecks(
        {
          ...base,
          status: 'failed',
          code: 'evidence_malformed',
          reason: 'raw_event is not valid base64 JSON',
        },
        unchecked,
      );
    }
    rawEvent = parsed.value;
  } catch {
    return withChecks(
      {
        ...base,
        status: 'failed',
        code: 'evidence_malformed',
        reason: 'raw_event is not valid base64 JSON',
      },
      unchecked,
    );
  }

  if (!rawEvent || typeof rawEvent !== 'object' || !rawEvent.payload || typeof rawEvent.signature !== 'string') {
    return withChecks(
      {
        ...base,
        status: 'failed',
        code: 'evidence_malformed',
        reason: 'raw_event missing payload or signature',
      },
      unchecked,
    );
  }

  const trust = resolveTrustedKey(item, rawEvent, trustedById, barePubkeys);
  if (!trust.ok) {
    return withChecks(
      {
        ...base,
        signer: trust.pubkey,
        status: 'failed',
        code: trust.code,
        reason: trust.reason,
      },
      {
        signature: STAGE_NOT_CHECKED,
        binding: STAGE_NOT_CHECKED,
        authority: stage('failed', trust.code),
      },
    );
  }
  const signerHex = trust.pubkey;
  const authority = STAGE_PASSED;

  let canonicalPayload;
  try {
    // Same bytes the server signs: JCS-canonical payload, not the raw_event envelope.
    canonicalPayload = canonicalizePayload(rawEvent.payload);
  } catch (err) {
    return withChecks(
      {
        ...base,
        signer: signerHex,
        status: 'failed',
        code: 'evidence_malformed',
        reason: `canonicalize failed: ${err.message}`,
      },
      {
        signature: STAGE_NOT_CHECKED,
        binding: STAGE_NOT_CHECKED,
        authority,
      },
    );
  }

  const sigOk = verifyEd25519Signature(canonicalPayload, rawEvent.signature, signerHex);
  if (!sigOk) {
    return withChecks(
      {
        ...base,
        signer: signerHex,
        status: 'failed',
        code: 'evidence_signature_invalid',
        reason: 'Invalid ed25519 signature over JCS-canonical payload',
      },
      {
        signature: stage('failed', 'evidence_signature_invalid'),
        binding: STAGE_NOT_CHECKED,
        authority,
      },
    );
  }

  let binding;
  try {
    binding = checkActionBinding(
      rawEvent.payload,
      Array.isArray(item.claims) ? item.claims : undefined,
      proposedAction,
    );
  } catch (err) {
    binding = {
      ok: false,
      code: 'action_binding_malformed',
      reason: err instanceof Error ? err.message : 'Action-binding check failed',
    };
  }

  if (!binding.ok) {
    return withChecks(
      {
        ...base,
        signer: signerHex,
        status: 'failed',
        code: binding.code,
        reason: binding.reason,
      },
      {
        signature: STAGE_PASSED,
        binding: stage('failed', binding.code),
        authority,
      },
    );
  }

  const signedClaims = readSignedClaims(rawEvent.payload);
  if (!signedClaims.ok) {
    return withChecks(
      {
        ...base,
        signer: signerHex,
        status: 'failed',
        code: signedClaims.code,
        reason: signedClaims.reason,
      },
      {
        signature: STAGE_PASSED,
        binding: binding.checked ? STAGE_PASSED : STAGE_NOT_CHECKED,
        authority,
      },
    );
  }

  return withChecks(
    {
      ...base,
      signer: signerHex,
      status: 'recomputed',
      code: null,
      reason: null,
      claims: Array.isArray(item.claims) ? item.claims : [],
    },
    {
      signature: STAGE_PASSED,
      binding: binding.checked ? STAGE_PASSED : STAGE_NOT_CHECKED,
      authority,
    },
  );
}

function portableItemRecord(result) {
  return {
    index: result.index,
    status: result.status,
    code: result.code ?? null,
    signature: result.checks.signature,
    binding: result.checks.binding,
    authority: result.checks.authority,
  };
}

function formatStage(stageResult) {
  if (!stageResult) return 'not_checked';
  return stageResult.code ? `${stageResult.status}:${stageResult.code}` : stageResult.status;
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

function verifyEvidenceOffline(request, trustedById, barePubkeys) {
  console.log('\n=== F5 Offline ed25519 (caller-trusted keys only) ===');
  console.log('Note: server evidence_verification[].status is NOT trusted.');
  console.log('Note: signature is over JCS-canonical payload inside raw_event (not envelope bytes).');

  const items = request.signed_evidence;
  if (!Array.isArray(items) || items.length === 0) {
    console.log('ℹ️  No signed_evidence in original request — nothing to recompute.');
    return { ok: true, results: [], hadEvidence: false };
  }

  if (trustedById.size === 0 && barePubkeys.size === 0) {
    console.log('❌ signed_evidence present but no --trusted-pubkey / --trusted-key supplied');
    console.log('   Refusing to treat server status as proof.');
    console.log('   Each item still reports signature, binding, and authority below.');
  }

  const proposedAction = proposedActionSource(request);
  const results = items.map((item, i) =>
    recomputeEvidenceItem(item, i, trustedById, barePubkeys, proposedAction),
  );
  let allOk = true;
  for (const r of results) {
    const mark = r.status === 'recomputed' ? '✅' : '❌';
    console.log(`${mark} [${r.index}] status=${r.status}${r.code ? ` code=${r.code}` : ''}`);
    console.log(
      `      checks signature=${formatStage(r.checks.signature)} binding=${formatStage(r.checks.binding)} authority=${formatStage(r.checks.authority)}`,
    );
    console.log(`PORTABLE_ITEM ${JSON.stringify(portableItemRecord(r))}`);
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

  // original-request is always required for offline pass (fail closed)
  if (!args.requestPath) {
    console.error('Error: original-request.json is required for offline verification.');
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

  let request;
  try {
    request = JSON.parse(readFileSync(args.requestPath, 'utf8'));
  } catch (err) {
    console.error(`Error loading request: ${err.message}`);
    process.exit(2);
  }

  // Defaults false — never exit 0 without successful recompute
  let digestOk = false;
  let evidenceOk = false;

  digestOk = verifyDigest(receipt, request);
  const ev = verifyEvidenceOffline(request, args.trustedById, args.barePubkeys);
  evidenceOk = ev.ok;
  crossCheckServerClaims(receipt, ev.results);

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
