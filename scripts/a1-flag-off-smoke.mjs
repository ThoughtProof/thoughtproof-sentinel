#!/usr/bin/env node
/**
 * A1 post-deploy smoke: pin on main, SHADOW_ADR0020 off.
 * - health OK
 * - minimal verify returns body without shadow fields
 * - free-text action_hash → 400
 * - structured action_hash + required_conditions accepted; body still shadow-free
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_DIR = join(ROOT, 'reports');
mkdirSync(OUT_DIR, { recursive: true });

const BASE = process.env.SENTINEL_URL?.replace(/\/sentinel\/verify$/, '') ||
  'https://sentinel.thoughtproof.ai';

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const raw = s.startsWith('export ') ? s.slice(7) : s;
    const i = raw.indexOf('=');
    if (i < 0) continue;
    const k = raw.slice(0, i).trim();
    let v = raw.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (
      ['SENTINEL_API_KEY', 'X_SENTINEL_KEY', 'TP_API_KEY', 'THOUGHTPROOF_API_KEY'].includes(k) &&
      v &&
      !process.env[k]
    ) {
      process.env[k] = v;
    }
  }
}

for (const f of [
  '/Users/rauljager/PROJECTS/ThoughtProof/verified-wallet-agent/.env',
  '/Users/rauljager/PROJECTS/ThoughtProof/openserv-sentinel/.env',
  '/Users/rauljager/PROJECTS/ThoughtProof/verified-trading-agent/.env',
  '/Users/rauljager/PROJECTS/ThoughtProof/guardian-pwa/.env.local',
  '/Users/rauljager/PROJECTS/ThoughtProof/decision-quality-layer/.env.local',
]) {
  loadEnv(f);
}

const key =
  process.env.SENTINEL_API_KEY ||
  process.env.X_SENTINEL_KEY ||
  process.env.TP_API_KEY ||
  process.env.THOUGHTPROOF_API_KEY ||
  '';

if (!key) {
  console.error('missing SENTINEL_API_KEY');
  process.exit(2);
}

async function req(path, body) {
  const url = `${BASE}${path}`;
  const init = body
    ? {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentinel-Key': key,
        },
        body: JSON.stringify(body),
      }
    : { method: 'GET' };
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* raw */
  }
  return { status: res.status, text, json };
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const health = await req('/sentinel/health');
check('health_200', health.status === 200, `status=${health.status}`);

const minimal = await req('/sentinel/verify', {
  claim: 'a1 deploy smoke',
  evidence: 'flag off path',
  mode: 'handoff',
  tier: 'swift',
});
check('minimal_verify_2xx', minimal.status >= 200 && minimal.status < 300, `status=${minimal.status}`);
check(
  'minimal_no_shadow_field',
  minimal.json && !Object.prototype.hasOwnProperty.call(minimal.json, 'shadow'),
  minimal.json ? `verdict=${minimal.json.verdict}` : minimal.text.slice(0, 120),
);

const badHash = await req('/sentinel/verify', {
  claim: 'x',
  evidence: 'y',
  mode: 'handoff',
  action_hash: 'user@example.com secret',
});
check('free_text_action_hash_400', badHash.status === 400, `status=${badHash.status}`);
const badMsg = JSON.stringify(badHash.json ?? badHash.text);
check(
  'free_text_action_hash_mentions_hex',
  /0x|hex|action_hash/i.test(badMsg),
  badMsg.slice(0, 160),
);

const goodHash = `0x${'ab'.repeat(32)}`;
const structured = await req('/sentinel/verify', {
  claim: 'structured smoke',
  evidence: 'ok',
  mode: 'action_authorization',
  tier: 'swift',
  action_hash: goodHash,
  required_conditions: [
    {
      condition_id: 'alpha_required',
      required: true,
      proof_requirement: 'machine',
      evidence_bindings: [],
    },
  ],
});
check(
  'structured_verify_2xx',
  structured.status >= 200 && structured.status < 300,
  `status=${structured.status}`,
);
check(
  'structured_no_shadow_field',
  structured.json && !Object.prototype.hasOwnProperty.call(structured.json, 'shadow'),
  structured.json ? `verdict=${structured.json.verdict}` : structured.text.slice(0, 120),
);

const report = {
  ts: new Date().toISOString(),
  base: BASE,
  expected_commit: 'ebb8fe6',
  flag: 'SHADOW_ADR0020 expected unset/off',
  checks,
  pass: checks.every((c) => c.ok),
  samples: {
    minimal_id: minimal.json?.id ?? null,
    structured_id: structured.json?.id ?? null,
    bad_hash_status: badHash.status,
  },
};

const out = join(OUT_DIR, `a1-flag-off-smoke-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ pass: report.pass, out }, null, 2));
process.exit(report.pass ? 0 : 1);
