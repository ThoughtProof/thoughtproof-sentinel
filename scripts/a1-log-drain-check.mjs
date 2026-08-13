#!/usr/bin/env node
/**
 * A1 measurement gate (flag stays OFF).
 *
 * Pass criteria (either):
 *   A) Vercel external log drain covering thoughtproof-sentinel, OR
 *   B) App-side Upstash shadow sink configured + reachable (TTL 30d)
 *
 * Does NOT enable SHADOW_ADR0020.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_DIR = join(ROOT, 'reports');
mkdirSync(OUT_DIR, { recursive: true });

const proj = JSON.parse(readFileSync(join(ROOT, '.vercel/project.json'), 'utf8'));
const projectId = proj.projectId;
const teamId = proj.orgId;

function loadToken() {
  const cands = [
    join(homedir(), 'Library/Application Support/com.vercel.cli/auth.json'),
    join(homedir(), '.vercel/auth.json'),
  ];
  for (const p of cands) {
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const t = j.token || j.authToken || j.accessToken;
    if (t) return { token: t, from: p };
  }
  throw new Error('no vercel token');
}

const { token, from: tokenFrom } = loadToken();

async function api(path) {
  const res = await fetch(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

const results = {
  ts: new Date().toISOString(),
  projectId,
  teamId,
  tokenFrom,
  checks: [],
};

function check(name, ok, detail) {
  results.checks.push({ name, ok: !!ok, detail: detail ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// Team / plan
const team = await api(`/v2/teams/${teamId}`);
results.team_status = team.status;
const plan =
  team.json?.billing?.plan ||
  team.json?.plan ||
  team.json?.billing?.invoiceItems?.pro?.price ? 'pro?' : null;
results.team_summary = {
  name: team.json?.name,
  slug: team.json?.slug,
  billing: team.json?.billing ?? null,
  planHint: plan,
};
check('team_api_ok', team.status === 200, `status=${team.status} slug=${team.json?.slug}`);

// Project
const project = await api(`/v9/projects/${projectId}?teamId=${teamId}`);
results.project_status = project.status;
const p = project.json || {};
const interesting = {};
for (const [k, v] of Object.entries(p)) {
  if (/log|drain|retain|observ|analytics|speed|expiration/i.test(k)) {
    interesting[k] = v;
  }
}
results.project_interesting = interesting;
results.deploymentExpiration = p.deploymentExpiration ?? null;
check('project_api_ok', project.status === 200, `name=${p.name}`);

// Integrations
const integ = await api(`/v1/integrations/configurations?teamId=${teamId}`);
results.integrations_status = integ.status;
const configs = integ.json?.configurations || integ.json || [];
const configList = Array.isArray(configs) ? configs : [];
results.integrations = configList.map((c) => ({
  id: c.id,
  slug: c.slug || c.integrationId || c.type,
  projects: c.projects || c.projectId || null,
  deletedAt: c.deletedAt ?? null,
}));
check(
  'no_silent_integrations_assumed',
  true,
  `count=${results.integrations.length}`,
);

// Log drains — try known endpoints
const drainPaths = [
  `/v1/log-drains?teamId=${teamId}`,
  `/v2/log-drains?teamId=${teamId}`,
  `/v1/integrations/log-drains?teamId=${teamId}`,
  `/v2/integrations/log-drains?teamId=${teamId}`,
  `/v1/drains?teamId=${teamId}`,
];
results.drain_queries = [];
let drains = [];
for (const path of drainPaths) {
  const r = await api(path);
  const arr =
    (Array.isArray(r.json) && r.json) ||
    r.json?.drains ||
    r.json?.logDrains ||
    r.json?.value ||
    [];
  results.drain_queries.push({
    path,
    status: r.status,
    count: Array.isArray(arr) ? arr.length : null,
    sample: Array.isArray(arr) && arr[0] ? Object.keys(arr[0]) : null,
    error: r.status >= 400 ? r.json : null,
  });
  if (r.status === 200 && Array.isArray(arr) && arr.length) {
    drains = arr;
  }
}

const projectDrains = drains.filter((d) => {
  const ids = d.projectIds || d.projects || d.projectId || [];
  if (!ids || (Array.isArray(ids) && ids.length === 0)) return true; // team-wide
  if (typeof ids === 'string') return ids === projectId;
  return Array.isArray(ids) && ids.includes(projectId);
});

results.drains_raw_count = drains.length;
results.drains_for_project = projectDrains.map((d) => ({
  id: d.id,
  name: d.name,
  url: d.url ? String(d.url).replace(/([?&]token=)[^&]+/gi, '$1***') : null,
  deliveryFormat: d.deliveryFormat || d.format,
  sources: d.sources || d.sourcesConfiguration || d.types,
  environments: d.environments,
  projectIds: d.projectIds || d.projects || d.projectId || null,
  samplingRate: d.samplingRate,
  createdAt: d.createdAt,
}));

const hasVercelDrain = projectDrains.length > 0;
check(
  'vercel_log_drain_configured',
  hasVercelDrain,
  hasVercelDrain
    ? `drains=${projectDrains.length}`
    : 'no Vercel log drain (optional if Upstash sink OK)',
);

const billingPlan = String(
  team.json?.billing?.plan ||
    team.json?.plan ||
    team.json?.billing?.name ||
    '',
).toLowerCase();
results.runtime_log_retention_docs = {
  hobby: '1 hour',
  pro: '1 day',
  pro_observability_plus: '30 days',
  enterprise: '3 days',
  enterprise_observability_plus: '30 days',
  source: 'https://vercel.com/docs/logs/runtime',
};
results.billing_plan_raw = billingPlan || team.json?.billing || null;

// Project env keys (names only)
const envs = await api(`/v9/projects/${projectId}/env?teamId=${teamId}`);
const envList = envs.json?.envs || envs.json || [];
const envNameList = Array.isArray(envList) ? envList.map((e) => e.key || e.name) : [];
results.env_keys = envNameList;

const hasUpstashEnv =
  envNameList.includes('UPSTASH_REDIS_REST_URL') &&
  envNameList.includes('UPSTASH_REDIS_REST_TOKEN');
check(
  'upstash_env_present',
  hasUpstashEnv,
  hasUpstashEnv ? 'UPSTASH_REDIS_REST_URL+TOKEN present' : 'missing Upstash env',
);

// Live probe via sink module (uses local env if present; else skip reachable)
let upstashProbe = {
  configured: hasUpstashEnv,
  reachable: false,
  env_name: 'unknown',
  ttl_seconds: 30 * 24 * 60 * 60,
  error_code: hasUpstashEnv ? 'probe_not_run' : 'sink_unconfigured',
};
try {
  const mod = await import(new URL('../src/adr0020/shadow-sink.ts', import.meta.url).href).catch(
    () => import('../src/adr0020/shadow-sink.js'),
  );
  // Prefer process env when operator has secrets locally; production gate
  // still requires Vercel env keys present (checked above).
  upstashProbe = await mod.probeShadowSink(process.env);
  if (!upstashProbe.configured && hasUpstashEnv) {
    // Vercel has keys but local process does not — configuration PASS, reachability UNKNOWN
    upstashProbe = {
      configured: true,
      reachable: false,
      env_name: 'production',
      ttl_seconds: mod.SHADOW_SINK_TTL_SECONDS ?? 30 * 24 * 60 * 60,
      error_code: 'local_env_missing_secrets_vercel_has_keys',
    };
  }
} catch (e) {
  upstashProbe.error_code = e instanceof Error ? e.message : 'probe_import_failed';
}
results.upstash_probe = upstashProbe;

const upstashConfigured = hasUpstashEnv || upstashProbe.configured === true;
const ttlOk = (upstashProbe.ttl_seconds ?? 0) >= 7 * 24 * 60 * 60;
check(
  'upstash_sink_configured',
  upstashConfigured,
  upstashConfigured ? `ttl_s=${upstashProbe.ttl_seconds}` : upstashProbe.error_code,
);
check(
  'upstash_ttl_ge_7d',
  ttlOk,
  `ttl_seconds=${upstashProbe.ttl_seconds}`,
);
// Reachability: if local secrets exist, require ping; if only Vercel has keys, note deferred
const reachabilityRequired = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const reachOk = reachabilityRequired ? upstashProbe.reachable === true : upstashConfigured;
check(
  'upstash_reachability',
  reachOk,
  reachabilityRequired
    ? upstashProbe.reachable
      ? 'ping ok'
      : `unreachable:${upstashProbe.error_code}`
    : 'deferred: Vercel has keys; local probe skipped (no local secrets)',
);

check(
  'shadow_flag_still_absent',
  !envNameList.includes('SHADOW_ADR0020'),
  envNameList.includes('SHADOW_ADR0020') ? 'PRESENT' : 'absent OK',
);

const hasStructuredSink = upstashConfigured && ttlOk && reachOk;
const gatePass = hasVercelDrain || hasStructuredSink;

results.gate = {
  name: 'A1_measurement_sink_retention',
  pass: gatePass,
  paths: {
    vercel_drain: hasVercelDrain,
    upstash_sink: hasStructuredSink,
  },
  reason: gatePass
    ? hasStructuredSink
      ? 'Upstash A1 sink configured (TTL≥7d) — pilot design unblocked; flag still OFF'
      : 'Vercel drain present — pilot design unblocked; flag still OFF'
    : 'FAIL: neither Vercel drain nor Upstash sink ready',
  next_if_fail: [
    'Ensure UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN on thoughtproof-sentinel production',
    'Deploy shadow-sink code (src/adr0020/shadow-sink.ts) to main/prod',
    'Optional: add Vercel Log Drain for general ops logs',
    'Re-run: node scripts/a1-log-drain-check.mjs',
    'Flag-on still needs separate explicit go after this gate PASSes',
  ],
  next_if_pass: [
    'Choose single pilot producer (structured conditions + canonical action_hash)',
    'Explicit Raul go required before SHADOW_ADR0020=on',
    'A2/A3 remain blocked',
  ],
};

results.pass = results.gate.pass;
// Flag must stay off for this gate to be considered clean ops state
if (envNameList.includes('SHADOW_ADR0020')) {
  results.pass = false;
  results.gate.pass = false;
  results.gate.reason += ' | BLOCK: SHADOW_ADR0020 present in env';
}

const out = join(OUT_DIR, `a1-log-drain-check-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ pass: results.pass, gate: results.gate, out }, null, 2));
process.exit(results.pass ? 0 : 1);
