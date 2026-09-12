#!/usr/bin/env node
/**
 * Generate M1 signed canonical export vectors for PriorSeal / YuTao.
 *
 * VECTOR-ONLY key:
 *   kid  = tp-sentinel-export-ed25519-2026-09-vector
 *   status in data/thoughtproof-keys.json = "vector-only"
 *   seed below is intentional fixture material — MUST NEVER be the active prod kid.
 *
 * PRODUCTION key:
 *   kid  = tp-sentinel-export-ed25519-2026-09
 *   status = "active"
 *   private key ONLY in env SENTINEL_EXPORT_PRIVATE_KEY (not in this repo).
 *
 *   node scripts/gen-m1-export-vectors.mjs
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import canonicalize from 'canonicalize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'fixtures', 'm1-export');
mkdirSync(outDir, { recursive: true });

const VECTOR_KID = 'tp-sentinel-export-ed25519-2026-09-vector';
const PROD_KID = 'tp-sentinel-export-ed25519-2026-09';
const DOMAIN = 'thoughtproof.sentinel.export.v1';

const VECTOR_SEED_HEX =
  'b66ae2bdbbba3a8c6ef77e3d627153f6c8d9d1308d9a3d4d99482e564d7903f6';
const EXPECT_VECTOR_X = 'IuMSTQMowwaP3yaOmlf9unkZAVjvc9MwOOqluXCjFDs';
const EXPECT_PROD_X = 'rKfORFLuIi74fCI9DZEpefBXcKFU4e_0CuYuSH7Fh98';

const FIXTURE_JCS =
  '{"apiVersion":"sentinel-api-0.1.0","artifactSchema":"sentinel.verdict.canonical.v1","confidence":84,"evaluatedAt":1782916498,"mode":"trade_execution","models":{"primary":"serv-nano","secondary":"serv-swift"},"objections":["step_0: Direction claim verified against market data."],"reasoning":"All steps adequately supported by the evidence.","tier":"standard","verdict":"ALLOW","verificationId":"sent_9f3c2a7b1e004d68"}';
const FIXTURE_HASH =
  '0x419c360db82ee72be3411acd2d30f560b3f62842c2162fa3cb4a08c1fa4ce65a';

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function privateFromSeedHex(seedHex) {
  const seed = Buffer.from(seedHex, 'hex');
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}

function pubX(privateKey) {
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return b64url(Buffer.from(der).subarray(der.length - 32));
}

const vectorPrivate = privateFromSeedHex(VECTOR_SEED_HEX);
const vectorX = pubX(vectorPrivate);
if (vectorX !== EXPECT_VECTOR_X) {
  throw new Error(`vector seed/x drift: got ${vectorX} expected ${EXPECT_VECTOR_X}`);
}

const keysDoc = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'thoughtproof-keys.json'), 'utf8'),
);
const vectorEntry = keysDoc.keys.find((k) => k.kid === VECTOR_KID);
const prodEntry = keysDoc.keys.find((k) => k.kid === PROD_KID);
if (!vectorEntry || vectorEntry.status !== 'vector-only' || vectorEntry.x !== EXPECT_VECTOR_X) {
  throw new Error('keys doc vector entry missing/wrong status/x');
}
if (!prodEntry || prodEntry.status !== 'active' || prodEntry.x !== EXPECT_PROD_X) {
  throw new Error('keys doc prod entry missing/wrong status/x');
}
if (vectorEntry.x === prodEntry.x || VECTOR_KID === PROD_KID) {
  throw new Error('FATAL: vector and prod keys must differ');
}

function jcs(obj) {
  const out = canonicalize(obj);
  if (typeof out !== 'string') throw new Error('canonicalize failed');
  return out;
}

function buildSignedInput(fields) {
  return Buffer.concat([
    Buffer.from(DOMAIN, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(jcs(fields), 'utf8'),
  ]);
}

function issue(fields, privateKey) {
  const signedInput = buildSignedInput(fields);
  const sig = cryptoSign(null, signedInput, privateKey);
  return {
    exportSchema: DOMAIN,
    ...fields,
    signature: '0x' + Buffer.from(sig).toString('hex'),
    _signedInputHex: signedInput.toString('hex'),
  };
}

const signedAt = 1782916498;
const ttl = 86400;
const baseFields = {
  artifactSchema: 'sentinel.verdict.canonical.v1',
  verificationId: 'sent_9f3c2a7b1e004d68',
  canonical: FIXTURE_JCS,
  digest: FIXTURE_HASH,
  keyId: VECTOR_KID,
  alg: 'Ed25519',
  signedAt,
  validUntil: signedAt + ttl,
};

const d = '0x' + createHash('sha256').update(FIXTURE_JCS, 'utf8').digest('hex');
if (d !== FIXTURE_HASH) throw new Error('fixture digest drift');

const validFull = issue(baseFields, vectorPrivate);
const signedInputHex = validFull._signedInputHex;
const { _signedInputHex, ...valid } = validFull;

const tamperedCanonical = {
  ...valid,
  canonical: FIXTURE_JCS.replace('"ALLOW"', '"BLOCK"'),
};
const tamperedValidUntil = {
  ...valid,
  validUntil: baseFields.validUntil + 365 * 86400,
};

const { privateKey: wrongPriv } = generateKeyPairSync('ed25519');
const wrongFull = issue(baseFields, wrongPriv);
const { _signedInputHex: _w, ...wrongKey } = wrongFull;

const unknownFields = { ...baseFields, keyId: 'tp-sentinel-export-DOES-NOT-EXIST' };
const unknownFull = issue(unknownFields, vectorPrivate);
const { _signedInputHex: _u, ...unknownKey } = unknownFull;

function writeJson(name, obj) {
  writeFileSync(join(outDir, name), JSON.stringify(obj, null, 2) + '\n');
}

writeJson('export-valid.json', valid);
writeJson('export-tampered-canonical.json', tamperedCanonical);
writeJson('export-tampered-validUntil.json', tamperedValidUntil);
writeJson('export-wrong-key.json', wrongKey);
writeJson('export-unknown-keyId.json', unknownKey);

const readme = `# M1 signed canonical export vectors

## Key separation (non-negotiable)

| kid | status | private material | use |
|---|---|---|---|
| \`${VECTOR_KID}\` | \`vector-only\` | seed in \`gen-m1-export-vectors.mjs\` only | fixtures / paired checks |
| \`${PROD_KID}\` | \`active\` | **env only** \`SENTINEL_EXPORT_PRIVATE_KEY\` | production \`signed_export\` |

## alg names (do not cross-compare)

- **Export envelope** field \`alg\`: \`Ed25519\`
- **Key document** field \`alg\`: \`EdDSA\` (JOSE / RFC 8037)
- Same curve. Do not string-equals the two fields.

Key document schema: \`thoughtproof.keys.v1\` (OKP + TP status extensions). **Not** a pure JWKS.

## Canonical fixture

- digest: \`${FIXTURE_HASH}\`
- verificationId: \`sent_9f3c2a7b1e004d68\`

## Valid vector — expected signedInput bytes

Domain \`${DOMAIN}\` UTF-8, then \`0x00\`, then JCS of the signed fields (including \`validUntil\`).

\`\`\`
signedInputHex (${signedInputHex.length / 2} bytes):
${signedInputHex}
\`\`\`

## Verify order (PriorSeal §4)

1. Resolve keyId (status / notBefore / notAfter) → \`DECISION_SIGNER_UNTRUSTED\` on fail
2. Verify signature over \`domain || 0x00 || JCS(fields)\` → \`DECISION_SIGNATURE_INVALID\` on fail
3. Recompute sha256(transported canonical) === digest → \`DECISION_COMMITMENT_DIGEST_MISMATCH\`
4. optional validUntil

\`DECISION_SIGNER_UNTRUSTED\` is **not** used for a broken signature on a known kid.

## Files

| File | Expect |
|---|---|
| \`export-valid.json\` | ok with \`--allow-vector-only\` |
| \`export-tampered-canonical.json\` | \`DECISION_SIGNATURE_INVALID\` |
| \`export-tampered-validUntil.json\` | \`DECISION_SIGNATURE_INVALID\` |
| \`export-wrong-key.json\` | \`DECISION_SIGNATURE_INVALID\` (kid resolves; sig fails under published x) |
| \`export-unknown-keyId.json\` | \`key_not_found\` / \`DECISION_SIGNER_UNTRUSTED\` |

## Verify locally

\`\`\`bash
node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-valid.json \\
  --keys data/thoughtproof-keys.json --now ${signedAt} --allow-vector-only

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-valid.json \\
  --keys data/thoughtproof-keys.json --now ${signedAt}; echo exit:\$?

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-tampered-canonical.json \\
  --keys data/thoughtproof-keys.json --now ${signedAt} --allow-vector-only

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-tampered-validUntil.json \\
  --keys data/thoughtproof-keys.json --now ${signedAt} --allow-vector-only

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-wrong-key.json \\
  --keys data/thoughtproof-keys.json --now ${signedAt} --allow-vector-only

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-unknown-keyId.json \\
  --keys data/thoughtproof-keys.json --now ${signedAt} --allow-vector-only
\`\`\`

Regenerate: \`node scripts/gen-m1-export-vectors.mjs\`
`;

writeFileSync(join(outDir, 'README.md'), readme);
console.log(
  JSON.stringify(
    {
      ok: true,
      outDir,
      vectorKid: VECTOR_KID,
      prodKid: PROD_KID,
      vectorX,
      prodX: prodEntry.x,
      verificationId: valid.verificationId,
      digest: valid.digest,
      signedInputBytes: signedInputHex.length / 2,
    },
    null,
    2,
  ),
);
