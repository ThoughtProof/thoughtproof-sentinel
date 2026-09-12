#!/usr/bin/env node
/**
 * Generate M1 signed canonical export vectors for PriorSeal / YuTao.
 *
 * Uses the published pilot kid tp-sentinel-export-ed25519-2026-09.
 * Seed is VECTOR-ONLY (also used to regenerate fixtures). Production must
 * use a distinct env key; rotate kid when leaving pilot.
 *
 *   node scripts/gen-m1-export-vectors.mjs
 *
 * Writes:
 *   scripts/fixtures/m1-export/export-valid.json
 *   scripts/fixtures/m1-export/export-tampered-canonical.json
 *   scripts/fixtures/m1-export/export-tampered-validUntil.json
 *   scripts/fixtures/m1-export/README.md
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
} from 'crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import canonicalize from 'canonicalize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'fixtures', 'm1-export');
mkdirSync(outDir, { recursive: true });

const KID = 'tp-sentinel-export-ed25519-2026-09';
const DOMAIN = 'thoughtproof.sentinel.export.v1';
/** VECTOR-ONLY seed — matches data/thoughtproof-keys.json publicKey. Not for prod. */
const SEED_HEX = 'b66ae2bdbbba3a8c6ef77e3d627153f6c8d9d1308d9a3d4d99482e564d7903f6';
const EXPECT_PUB =
  '22e3124d0328c3068fdf268e9a57fdba79190158ef73d33038eaa5b970a3143b';

const FIXTURE_JCS =
  '{"apiVersion":"sentinel-api-0.1.0","artifactSchema":"sentinel.verdict.canonical.v1","confidence":84,"evaluatedAt":1782916498,"mode":"trade_execution","models":{"primary":"serv-nano","secondary":"serv-swift"},"objections":["step_0: Direction claim verified against market data."],"reasoning":"All steps adequately supported by the evidence.","tier":"standard","verdict":"ALLOW","verificationId":"sent_9f3c2a7b1e004d68"}';
const FIXTURE_HASH =
  '0x419c360db82ee72be3411acd2d30f560b3f62842c2162fa3cb4a08c1fa4ce65a';

const seed = Buffer.from(SEED_HEX, 'hex');
const pkcs8 = Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'),
  seed,
]);
const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey);
const pubDer = publicKey.export({ type: 'spki', format: 'der' });
const pubHex = Buffer.from(pubDer).subarray(pubDer.length - 32).toString('hex');
if (pubHex !== EXPECT_PUB) {
  throw new Error(`seed/pubkey drift: got ${pubHex} expected ${EXPECT_PUB}`);
}

const keysDoc = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'thoughtproof-keys.json'), 'utf8'),
);
const published = keysDoc.keys.find((k) => k.kid === KID);
if (!published || published.publicKey !== EXPECT_PUB) {
  throw new Error('data/thoughtproof-keys.json publicKey mismatch vs vector seed');
}

function jcs(obj) {
  const out = canonicalize(obj);
  if (typeof out !== 'string') throw new Error('canonicalize failed');
  return out;
}

function buildSignedInput(fields) {
  const body = { ...fields };
  return Buffer.concat([
    Buffer.from(DOMAIN, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(jcs(body), 'utf8'),
  ]);
}

function issue(fields) {
  const sig = cryptoSign(null, buildSignedInput(fields), privateKey);
  return {
    exportSchema: DOMAIN,
    ...fields,
    signature: '0x' + Buffer.from(sig).toString('hex'),
  };
}

const signedAt = 1782916498; // same instant as fixture evaluatedAt
const ttl = 86400;
const baseFields = {
  artifactSchema: 'sentinel.verdict.canonical.v1',
  verificationId: 'sent_9f3c2a7b1e004d68',
  canonical: FIXTURE_JCS,
  digest: FIXTURE_HASH,
  keyId: KID,
  alg: 'Ed25519',
  signedAt,
  validUntil: signedAt + ttl,
};

// Sanity: digest of transported string
const d =
  '0x' + createHash('sha256').update(FIXTURE_JCS, 'utf8').digest('hex');
if (d !== FIXTURE_HASH) throw new Error('fixture digest drift');

const valid = issue(baseFields);

// Tamper 1: change canonical ALLOW→BLOCK but keep old digest + old sig
const tamperedCanonical = {
  ...valid,
  canonical: FIXTURE_JCS.replace('"ALLOW"', '"BLOCK"'),
};

// Tamper 2: stretch validUntil without re-signing
const tamperedValidUntil = {
  ...valid,
  validUntil: baseFields.validUntil + 365 * 86400,
};

writeFileSync(join(outDir, 'export-valid.json'), JSON.stringify(valid, null, 2) + '\n');
writeFileSync(
  join(outDir, 'export-tampered-canonical.json'),
  JSON.stringify(tamperedCanonical, null, 2) + '\n',
);
writeFileSync(
  join(outDir, 'export-tampered-validUntil.json'),
  JSON.stringify(tamperedValidUntil, null, 2) + '\n',
);

const readme = `# M1 signed canonical export vectors

**kid:** \`${KID}\`  
**domain:** \`${DOMAIN}\`  
**canonical fixture digest:** \`${FIXTURE_HASH}\`  
**keys doc:** \`data/thoughtproof-keys.json\` → live \`GET /.well-known/thoughtproof-keys.json\`

## Files

| File | Expect |
|---|---|
| \`export-valid.json\` | signature valid + digest match |
| \`export-tampered-canonical.json\` | \`digest_mismatch\` (transported bytes ≠ digest; do **not** re-verify via fresh /sentinel/verify) |
| \`export-tampered-validUntil.json\` | \`signature_invalid\` (validUntil is signed; stretch breaks sig) |

## Verify locally

\`\`\`bash
node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-valid.json \\
  --keys data/thoughtproof-keys.json --now ${signedAt}
node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-tampered-canonical.json \\
  --keys data/thoughtproof-keys.json --now ${signedAt}
node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-tampered-validUntil.json \\
  --keys data/thoughtproof-keys.json --now ${signedAt}
\`\`\`

## Receiver rules (PriorSeal M1)

1. Pin keys URL **and** kid out-of-band.
2. Verify envelope signature over \`domain || 0x00 || JCS(fields)\`.
3. Recompute sha256 over the **transported** \`canonical\` string; require equality with \`digest\`.
4. Digest identifies **one issued artifact**, never a fresh verification.
5. Namespace commitment: \`thoughtproof.sentinel-decision.v1\` / sha256 / lowercase \`0x\`+64 hex.
6. \`validUntil\` is envelope-only (not inside canonical.v1).

Regenerate: \`node scripts/gen-m1-export-vectors.mjs\`
`;

writeFileSync(join(outDir, 'README.md'), readme);
console.log(JSON.stringify({
  ok: true,
  outDir,
  kid: KID,
  verificationId: valid.verificationId,
  digest: valid.digest,
  signaturePrefix: valid.signature.slice(0, 18) + '…',
}, null, 2));
