#!/usr/bin/env node
/**
 * Live check: pilot allowed vs unknown/missing skipped (HTTP body still shadow-free).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const home = process.env.HOME || '';
for (const f of [
  join(home, 'PROJECTS/ThoughtProof/verified-wallet-agent/.env'),
  join(home, 'PROJECTS/ThoughtProof/openserv-sentinel/.env'),
  join(home, 'PROJECTS/ThoughtProof/verified-trading-agent/.env'),
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
  console.error('missing api key');
  process.exit(2);
}

const good = `0x${'ab'.repeat(32)}`;
const conds = [
  {
    condition_id: 'alpha_required',
    required: true,
    proof_requirement: 'machine',
    evidence_bindings: [
      {
        evidence_id: 'evidence:alpha_ok',
        bound_condition_id: 'alpha_required',
        syntactically_valid: true,
        freshness: 'fresh',
        contradicted: false,
        grade: 'machine',
      },
    ],
  },
  {
    condition_id: 'beta_required',
    required: true,
    proof_requirement: 'machine',
    evidence_bindings: [],
  },
];

async function post(body) {
  const res = await fetch('https://sentinel.thoughtproof.ai/sentinel/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentinel-Key': key,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return {
    status: res.status,
    verdict: json.verdict ?? null,
    id: json.id ?? null,
    has_shadow: Object.prototype.hasOwnProperty.call(json, 'shadow'),
  };
}

const cases = [
  {
    name: 'pilot',
    body: {
      claim: 'A1 allowlist pilot probe',
      evidence: 'synthetic structure-only',
      mode: 'action_authorization',
      tier: 'swift',
      action_hash: good,
      required_conditions: conds,
      agent_context: {
        agent_id: 'adr0020.a1.pilot.v0',
        agent_runtime: 'a1-pilot',
        environment: 'paper',
        tags: ['adr0020', 'a1-pilot'],
      },
    },
  },
  {
    name: 'unknown',
    body: {
      claim: 'A1 allowlist unknown probe',
      evidence: 'synthetic structure-only',
      mode: 'action_authorization',
      tier: 'swift',
      action_hash: good,
      required_conditions: conds,
      agent_context: { agent_id: 'unknown-other-agent', environment: 'paper' },
    },
  },
  {
    name: 'missing',
    body: {
      claim: 'A1 allowlist missing producer',
      evidence: 'synthetic structure-only',
      mode: 'action_authorization',
      tier: 'swift',
      action_hash: good,
      required_conditions: conds,
    },
  },
  {
    name: 'minimal',
    body: {
      claim: 'a1 smoke',
      evidence: 'flag path',
      mode: 'handoff',
      tier: 'swift',
    },
  },
];

const results = [];
for (const c of cases) {
  const r = await post(c.body);
  results.push({ name: c.name, ...r });
  console.log(JSON.stringify({ name: c.name, ...r }));
}

const pass =
  results.every((r) => r.status >= 200 && r.status < 300) &&
  results.every((r) => r.has_shadow === false);
console.log(JSON.stringify({ pass, n: results.length }, null, 2));
process.exit(pass ? 0 : 1);
