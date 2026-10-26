#!/usr/bin/env node
/**
 * Generate canonical.v2 signed-export vectors (ADR-0022).
 *
 * VECTOR-ONLY key — same fixture seed as scripts/gen-m1-export-vectors.mjs.
 * That seed is not a production key and must never be SENTINEL_EXPORT_PRIVATE_KEY.
 * This script writes scripts/fixtures/m1-export-v2/ only. It does not touch v1 vectors.
 *
 *   node scripts/gen-m1-export-v2-vectors.mjs
 */
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, sep } from 'path';
import { fileURLToPath } from 'url';
import canonicalize from 'canonicalize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'fixtures', 'm1-export-v2');
if (outDir.endsWith(`${sep}m1-export`)) {
  throw new Error('refusing to overwrite v1 m1-export vectors');
}
mkdirSync(outDir, { recursive: true });

const VECTOR_KID = 'tp-sentinel-export-ed25519-2026-09-vector';
const DOMAIN = 'thoughtproof.sentinel.export.v1';
const VECTOR_SEED_HEX =
  'b66ae2bdbbba3a8c6ef77e3d627153f6c8d9d1308d9a3d4d99482e564d7903f6';
const EXPECT_VECTOR_X = 'IuMSTQMowwaP3yaOmlf9unkZAVjvc9MwOOqluXCjFDs';

const RELEASE_ID = 'da6b6378e105d0c7e1f810bbe237d2f23c55c103';
const POLICY =
  'adr-0019-cascade-promotion-2026-08-08+p0-primary-error-fail-closed+p0-objective-mismatch-fail-closed+p0-informational-allowlist+p0-unknown-action-fail-closed+p0-unclassified-abstention-uncertain+p0-caller-declared-kinds';
const POT_CLI = '0.8.12';

const signedAt = 1782916498;
const ttl = 86400;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
if (!vectorEntry || vectorEntry.status !== 'vector-only' || vectorEntry.x !== EXPECT_VECTOR_X) {
  throw new Error('keys doc vector entry missing/wrong status/x');
}

function jcs(obj) {
  const out = canonicalize(obj);
  if (typeof out !== 'string') throw new Error('canonicalize failed');
  return out;
}

function v2Body({ releaseId, policy, potCli } = {}) {
  const body = {
    apiVersion: 'sentinel-api-0.1.0',
    artifactSchema: 'sentinel.verdict.canonical.v2',
    confidence: 84,
    evaluatedAt: signedAt,
    mode: 'trade_execution',
    models: { primary: 'serv-nano', secondary: 'serv-swift' },
    objections: ['step_0: Direction claim verified against market data.'],
    reasoning: 'All steps adequately supported by the evidence.',
    tier: 'standard',
    verdict: 'ALLOW',
    verificationId: 'sent_9f3c2a7b1e004d68',
  };
  if (policy) body.policy = policy;
  if (potCli) body.potCli = potCli;
  if (releaseId) body.releaseId = releaseId;
  return body;
}

function buildSignedInput(fields) {
  const signed = {
    artifactSchema: fields.artifactSchema,
    verificationId: fields.verificationId,
    canonical: fields.canonical,
    digest: fields.digest,
    keyId: fields.keyId,
    alg: fields.alg,
    signedAt: fields.signedAt,
  };
  if (fields.validUntil !== undefined) signed.validUntil = fields.validUntil;
  return Buffer.concat([
    Buffer.from(DOMAIN, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(jcs(signed), 'utf8'),
  ]);
}

function issue(body) {
  const canonical = jcs(body);
  const digest = '0x' + createHash('sha256').update(canonical, 'utf8').digest('hex');
  const fields = {
    artifactSchema: body.artifactSchema,
    verificationId: body.verificationId,
    canonical,
    digest,
    keyId: VECTOR_KID,
    alg: 'Ed25519',
    signedAt,
    validUntil: signedAt + ttl,
  };
  const sig = cryptoSign(null, buildSignedInput(fields), vectorPrivate);
  return {
    exportSchema: DOMAIN,
    ...fields,
    signature: '0x' + Buffer.from(sig).toString('hex'),
  };
}

function writeJson(name, obj) {
  writeFileSync(join(outDir, name), JSON.stringify(obj, null, 2) + '\n');
}

const valid = issue(v2Body({ releaseId: RELEASE_ID, policy: POLICY, potCli: POT_CLI }));
const omitted = issue(v2Body());
const tampered = {
  ...valid,
  canonical: valid.canonical.replace('"ALLOW"', '"BLOCK"'),
};

writeJson('export-v2-valid.json', valid);
writeJson('export-v2-omitted-optionals.json', omitted);
writeJson('export-v2-tampered-canonical.json', tampered);

const readme = `# Canonical v2 signed-export vectors (ADR-0022)

Same envelope domain and vector-only kid as \`scripts/fixtures/m1-export/\`.
The private seed is fixture material in \`scripts/gen-m1-export-v2-vectors.mjs\`
(the same vector-only seed as the v1 generator). It is not a production key.

v1 files under \`scripts/fixtures/m1-export/\` are not produced here.

## Provenance on the valid vector

- \`releaseId\`: \`${RELEASE_ID}\`
- \`policy\`: \`${POLICY}\`
- \`potCli\`: \`${POT_CLI}\` (fixture constant; live exports call \`getPotCliVersion()\`)

\`export-v2-omitted-optionals.json\` is the same projection with those three fields absent.
\`export-v2-tampered-canonical.json\` keeps the valid signature over a mutated canonical string.

## Verify locally

\`\`\`bash
node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export-v2/export-v2-valid.json \\
  --keys data/thoughtproof-keys.json --now ${signedAt} --allow-vector-only

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export-v2/export-v2-omitted-optionals.json \\
  --keys data/thoughtproof-keys.json --now ${signedAt} --allow-vector-only

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export-v2/export-v2-tampered-canonical.json \\
  --keys data/thoughtproof-keys.json --now ${signedAt} --allow-vector-only
\`\`\`

Regenerate: \`node scripts/gen-m1-export-v2-vectors.mjs\`
`;

writeFileSync(join(outDir, 'README.md'), readme);
console.log(JSON.stringify({
  ok: true,
  outDir,
  digest: valid.digest,
  omittedDigest: omitted.digest,
  verificationId: valid.verificationId,
}, null, 2));
