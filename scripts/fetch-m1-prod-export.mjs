#!/usr/bin/env node
/**
 * One-shot: call prod /sentinel/verify, save signed_export as export-prod-live.json
 * Usage: node scripts/fetch-m1-prod-export.mjs
 * Reads key from ~/.hermes/.credentials/sentinel-api-key-nightly (no echo).
 */
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const keyPath = join(homedir(), '.hermes/.credentials/sentinel-api-key-nightly');
const key = readFileSync(keyPath, 'utf8').trim();
if (!key) {
  console.error('missing nightly key');
  process.exit(1);
}

const body = {
  claim: 'M1 production export smoke: handoff packet is coherent.',
  evidence:
    'Operator smoke for PriorSeal M1. No market action. Fixture-grade claim only.',
  mode: 'handoff',
  tier: 'checkpoint',
};

const res = await fetch('https://sentinel.thoughtproof.ai/sentinel/verify', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Sentinel-Key': key,
    'X-Sentinel-Agent-Id': 'm1-export-prod-vector',
  },
  body: JSON.stringify(body),
});
const text = await res.text();
let d;
try {
  d = JSON.parse(text);
} catch {
  console.error('non-json', res.status, text.slice(0, 400));
  process.exit(1);
}
if (!res.ok) {
  console.error('http', res.status, d.error || d.code || d);
  process.exit(1);
}
const se = d.signed_export;
if (!se) {
  console.error('NO_SIGNED_EXPORT', {
    status: res.status,
    id: d.id,
    verdict: d.verdict,
    keys: Object.keys(d),
  });
  process.exit(2);
}

const outDir = join(__dirname, 'fixtures', 'm1-export');
const out = join(outDir, 'export-prod-live.json');
writeFileSync(out, JSON.stringify(se, null, 2) + '\n');
writeFileSync(
  join(outDir, 'export-prod-live-meta.json'),
  JSON.stringify(
    {
      verificationId: d.id,
      verdict: d.verdict,
      mode: d.mode,
      tier: d.tier,
      keyId: se.keyId,
      digest: se.digest,
      signedAt: se.signedAt,
      validUntil: se.validUntil ?? null,
      fetchedAt: new Date().toISOString(),
      endpoint: 'https://sentinel.thoughtproof.ai/sentinel/verify',
    },
    null,
    2,
  ) + '\n',
);

console.log(
  JSON.stringify(
    {
      ok: true,
      out,
      keyId: se.keyId,
      verificationId: se.verificationId,
      digest: se.digest,
      signedAt: se.signedAt,
      validUntil: se.validUntil ?? null,
      verdict: d.verdict,
    },
    null,
    2,
  ),
);

const v = spawnSync(
  process.execPath,
  [
    join(__dirname, 'verify-canonical-export.mjs'),
    out,
    '--keys',
    'https://sentinel.thoughtproof.ai/.well-known/thoughtproof-keys.json',
  ],
  { encoding: 'utf8' },
);
console.log('verify_exit', v.status);
console.log(v.stdout || v.stderr);
process.exit(v.status === 0 ? 0 : 3);
