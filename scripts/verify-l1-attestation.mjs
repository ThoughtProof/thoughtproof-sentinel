#!/usr/bin/env node
/**
 * Verify a Sentinel L1 issued attestation (jws-ed25519).
 *
 *   node scripts/verify-l1-attestation.mjs <l1.json>
 *
 * Accepts either:
 *   - full verify response with .attestation
 *   - { attestation: {...} }
 *   - bare IssuedSignAttestation object
 *
 * Canonicalization profile: rfc8785-canonicalize-utf8-v1
 * Prefer bytes in attestation.canonicalJson (do not re-serialize).
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS_PATH = join(__dirname, '../data/validation-keys.json');
const PROFILE = 'rfc8785-canonicalize-utf8-v1';

function loadAttestation(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (raw.attestation?.signature) return raw.attestation;
  if (raw.verify?.attestation?.signature) return raw.verify.attestation;
  if (raw.signature?.value && raw.canonicalJson) return raw;
  throw new Error('No L1 attestation found in file');
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node scripts/verify-l1-attestation.mjs <file.json>');
    process.exit(1);
  }
  const att = loadAttestation(path);
  const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8'));
  const key = keys.keys.find((k) => k.keyId === att.signature?.keyId && k.status === 'active');
  if (!key) {
    console.log(JSON.stringify({ ok: false, reason: 'key_not_found', keyId: att.signature?.keyId }, null, 2));
    process.exit(2);
  }

  const nameOk = att.signature?.canonicalization === PROFILE;
  const bytes = Buffer.from(att.canonicalJson, 'utf8');
  const hash = '0x' + createHash('sha256').update(bytes).digest('hex');
  const hashOk = hash === att.canonicalHash;
  const pub = createPublicKey(key.publicKeyPem);
  const sigOk = cryptoVerify(
    null,
    bytes,
    pub,
    Buffer.from(String(att.signature.value).replace(/^0x/, ''), 'hex'),
  );

  const out = {
    ok: !!(sigOk && hashOk && nameOk && att.issued),
    checks: {
      issued: !!att.issued,
      level: att.level,
      signatureValid: sigOk,
      hashMatch: hashOk,
      canonicalizationNameMatch: nameOk,
      expectedProfile: PROFILE,
      gotProfile: att.signature?.canonicalization,
      keyId: att.signature?.keyId,
      verificationId: att.verificationId,
      verdict: att.canonical?.verdict,
    },
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 3);
}

main();
