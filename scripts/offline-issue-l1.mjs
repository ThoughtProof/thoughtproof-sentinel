
import { readFileSync, writeFileSync } from 'fs';
import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, createHash } from 'crypto';
import canonicalize from 'canonicalize';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rawPath = process.argv[2];
const privPath = process.argv[3];
const pubPath = process.argv[4];
const outPath = process.argv[5];

const response = JSON.parse(readFileSync(rawPath, 'utf8'));
// Normalize objections if harness stripped them to strings
const objections = (response.objections || []).map((o, i) => {
  if (typeof o === 'string') {
    return { step_id: `step_${i}`, criterion: 'n/a', score: 0, predicate: 'n/a', quote: null, reasoning: o };
  }
  return o;
});

const confidence = Math.max(0, Math.min(100, Math.round((response.confidence ?? 0) * 100)));
const modelsUsed = response.meta?.models_used ?? [];
const models = { primary: modelsUsed[0] ?? 'unknown' };
if (modelsUsed.length > 1) models.secondary = modelsUsed[1];

const body = {
  artifactSchema: 'sentinel.verdict.canonical.v1',
  verificationId: response.id,
  apiVersion: 'sentinel-api-0.1.0',
  tier: response.tier,
  mode: response.mode,
  verdict: response.verdict,
  confidence,
  objections: objections.map(o => `${o.step_id}: ${o.reasoning}`),
  reasoning: response.reasoning ?? '',
  evaluatedAt: Math.floor(new Date(response.meta.verified_at).getTime() / 1000),
  models,
};
if (response.meta?.package_digest) body.packageDigest = response.meta.package_digest;
if (response.meta?.proof_strength) body.proofStrength = response.meta.proof_strength;
if (response.gate) {
  body.gate = {
    mode: response.gate.mode,
    wouldBlock: response.gate.wouldBlock,
    enforced: response.gate.enforced,
    violations: (response.gate.violations || []).map(v => v.detail || v),
  };
}

const canonicalJson = canonicalize(body);
const canonicalHash = '0x' + createHash('sha256').update(canonicalJson).digest('hex');
const priv = createPrivateKey(readFileSync(privPath));
const sig = cryptoSign(null, Buffer.from(canonicalJson, 'utf8'), priv);
const att = {
  prepared: true,
  issued: true,
  level: 'jws-ed25519',
  verificationId: body.verificationId,
  canonicalHash,
  canonicalJson,
  canonical: body,
  signature: {
    alg: 'Ed25519',
    keyId: 'tp-validation-ed25519-2026-07',
    value: '0x' + sig.toString('hex'),
    publicKeyRef: 'https://sentinel.thoughtproof.ai/.well-known/validation-keys.json#tp-validation-ed25519-2026-07',
    signedAt: new Date().toISOString(),
    canonicalization: 'rfc8785-canonicalize-utf8-v1',
  },
  claim_hash: response.attestation?.claim_hash,
  evidence_hash: response.attestation?.evidence_hash,
  schema_uid: response.attestation?.schema_uid,
};

const pub = createPublicKey(readFileSync(pubPath));
const ok = cryptoVerify(null, Buffer.from(canonicalJson,'utf8'), pub, Buffer.from(att.signature.value.slice(2), 'hex'));

writeFileSync(outPath, JSON.stringify({
  schema: 'tp.sentinel.l1-issued.v0',
  source_verificationId: response.id,
  source_verdict: response.verdict,
  offline_issue: true,
  note: 'L1 signed offline with pilot validation key matching well-known; deploy VALIDATION_ED25519_PRIVATE_KEY_PEM for in-API X-Sentinel-Issue: sign',
  attestation: att,
  verify_local: { ok },
}, null, 2));

console.log(JSON.stringify({ ok, verificationId: response.id, verdict: response.verdict, canonicalHash, issued: true }, null, 2));
