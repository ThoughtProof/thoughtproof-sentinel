#!/usr/bin/env node
/** F5 acceptance smoke — run: node scripts/f5-smoke.mjs */
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { generateKeyPairSync, sign, createHash } from 'crypto';
import canonicalize from 'canonicalize';

const dir = dirname(fileURLToPath(import.meta.url));
const fix = join(dir, 'fixtures', 'f5');
const script = join(dir, 'verify-receipt.mjs');
const pub = readFileSync(join(fix, 'pubkey.txt'), 'utf8').trim();

// Ensure no-evidence fixture exists
writeFileSync(
  join(fix, 'receipt-no-evidence.json'),
  JSON.stringify(
    {
      id: 'sent_f5_no_evidence',
      verdict: 'ALLOW',
      confidence: 80,
      tier: 'standard',
      mode: 'handoff',
      meta: {},
    },
    null,
    2,
  ) + '\n',
);

// Build a key_id-bound fixture pair for --trusted-key tests
function buildKeyIdFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const pubHex = Buffer.from(der).subarray(12).toString('hex');
  const payload = { action: 'transfer', amount: 1, key_id: 'ops-signer-1' };
  const canonical = canonicalize(payload);
  const sig = sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('hex');
  const raw_event = Buffer.from(
    JSON.stringify({ payload, signature: sig, key_id: 'ops-signer-1' }),
    'utf8',
  ).toString('base64');

  const request = {
    claim: 'key-id bound smoke',
    evidence: 'e',
    mode: 'handoff',
    tier: 'standard',
    signed_evidence: [
      {
        type: 'signed_event',
        raw_event,
        signature_scheme: 'ed25519',
        signer_pubkey: pubHex,
        key_id: 'ops-signer-1',
        claims: ['owner_signoff'],
        verification: 'required',
      },
    ],
  };
  const digest =
    'sha256:' + createHash('sha256').update(canonicalize(request), 'utf8').digest('hex');
  const receipt = {
    id: 'sent_f5_keyid',
    verdict: 'ALLOW',
    confidence: 90,
    tier: 'standard',
    mode: 'handoff',
    meta: {
      package_digest: digest,
      proof_strength: 'recomputed',
      evidence_verification: [{ index: 0, status: 'recomputed', signer: pubHex }],
    },
  };
  writeFileSync(join(fix, 'request-keyid.json'), JSON.stringify(request, null, 2) + '\n');
  writeFileSync(join(fix, 'receipt-keyid.json'), JSON.stringify(receipt, null, 2) + '\n');
  writeFileSync(join(fix, 'pubkey-keyid.txt'), pubHex + '\n');
  return pubHex;
}

const keyIdPub = buildKeyIdFixture();
// wrong pubkey bound to same id
const wrongPub = 'ab'.repeat(32);

function run(args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: r.status ?? 2, out: (r.stdout || '') + (r.stderr || '') };
}

const cases = [
  {
    name: 'valid+trusted passes',
    args: [join(fix, 'receipt-valid.json'), join(fix, 'request-valid.json'), '--trusted-pubkey', pub],
    expect: 0,
  },
  {
    name: 'forged claims recomputed fails offline',
    args: [join(fix, 'receipt-forged.json'), join(fix, 'request-forged.json'), '--trusted-pubkey', pub],
    expect: 1,
  },
  {
    name: 'evidence without trusted keys fails closed',
    args: [join(fix, 'receipt-valid.json'), join(fix, 'request-valid.json')],
    expect: 1,
  },
  {
    name: 'receipt-only (with evidence claim) fails closed (exit 2 = missing request)',
    args: [join(fix, 'receipt-valid.json')],
    expect: 2,
  },
  {
    name: 'receipt without evidence and without request fails closed (exit 2)',
    args: [join(fix, 'receipt-no-evidence.json')],
    expect: 2,
  },
  {
    name: 'receipt without evidence WITH request but no digest fails (exit 1)',
    args: [
      join(fix, 'receipt-no-evidence.json'),
      // reuse valid request so we have a request file; digest will mismatch/missing
      join(fix, 'request-valid.json'),
      '--trusted-pubkey',
      pub,
    ],
    expect: 1,
  },
  {
    name: 'trusted-key with matching key_id passes',
    args: [
      join(fix, 'receipt-keyid.json'),
      join(fix, 'request-keyid.json'),
      '--trusted-key',
      `ops-signer-1=${keyIdPub}`,
    ],
    expect: 0,
  },
  {
    name: 'trusted-key does NOT act as bare pubkey (wrong id fails)',
    args: [
      join(fix, 'receipt-keyid.json'),
      join(fix, 'request-keyid.json'),
      '--trusted-key',
      `other-id=${keyIdPub}`,
    ],
    expect: 1,
  },
  {
    name: 'trusted-key id bound to wrong pubkey fails',
    args: [
      join(fix, 'receipt-keyid.json'),
      join(fix, 'request-keyid.json'),
      '--trusted-key',
      `ops-signer-1=${wrongPub}`,
    ],
    expect: 1,
  },
];

let failed = 0;
for (const c of cases) {
  const r = run(c.args);
  const ok = r.code === c.expect;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name} (exit ${r.code}, expected ${c.expect})`);
  if (!ok) {
    failed++;
    console.log(r.out.slice(0, 500));
  }
}
process.exit(failed === 0 ? 0 : 1);
