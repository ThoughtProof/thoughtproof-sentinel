#!/usr/bin/env node
/**
 * A1 gate: verify Vercel log drains + team/plan retention context for Sentinel.
 * Does NOT enable SHADOW_ADR0020. Read-only.
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

check(
  'log_drain_configured_for_sentinel',
  projectDrains.length > 0,
  projectDrains.length
    ? `drains=${projectDrains.length}`
    : 'no log drain covering thoughtproof-sentinel',
);

// Retention gate from Vercel docs (runtime logs UI):
// Hobby 1h, Pro 1d, Pro+ObsPlus 30d, Ent 3d, Ent+ObsPlus 30d
// A1 needs >=7d retained searchable shadow events ideally; absolute minimum for canary is drain OR >=1d UI with export discipline.
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

const hasDrain = projectDrains.length > 0;
const hasLongRetention =
  /observability\s*plus|obs\s*plus/i.test(JSON.stringify(team.json || {})) ||
  false;

check(
  'retention_sufficient_for_a1_canary',
  hasDrain || hasLongRetention,
  hasDrain
    ? 'external drain present (retention = drain-side)'
    : hasLongRetention
      ? 'Observability Plus hinted'
      : 'UI-only runtime logs insufficient without drain (Pro≈1d / no long retention proven)',
);

// vercel CLI integrations already said no resources — double-check env for drain vendors
const envNames = [
  'AXIOM_',
  'DATADOG_',
  'DD_',
  'LOGTAIL_',
  'BETTERSTACK_',
  'NEW_RELIC_',
  'SENTRY_',
  'OTEL_',
  'HONEYCOMB_',
];
// Can't list secret values; use vercel env ls via child? skip — API project env
const envs = await api(`/v9/projects/${projectId}/env?teamId=${teamId}`);
const envList = envs.json?.envs || envs.json || [];
const envNameList = Array.isArray(envList) ? envList.map((e) => e.key || e.name) : [];
results.env_keys = envNameList;
const drainishEnv = envNameList.filter((k) =>
  envNames.some((p) => String(k).toUpperCase().startsWith(p) || String(k).toUpperCase().includes(p.replace(/_$/, ''))),
);
check(
  'no_third_party_log_env_required',
  true,
  drainishEnv.length ? `found=${drainishEnv.join(',')}` : 'no axiom/datadog/logtail env keys',
);
check(
  'shadow_flag_still_absent',
  !envNameList.includes('SHADOW_ADR0020'),
  envNameList.includes('SHADOW_ADR0020') ? 'PRESENT' : 'absent OK',
);

results.gate = {
  name: 'A1_log_drain_retention',
  pass: hasDrain, // strict: drain required before pilot/flag-on
  reason: hasDrain
    ? 'Drain covers Sentinel — proceed to pilot design (flag still off)'
    : 'FAIL gate: no log drain for thoughtproof-sentinel; flag-on and pilot producer remain blocked',
  next_if_fail: [
    'Add Vercel Log Drain (Axiom/Better Stack/custom HTTPS) for project thoughtproof-sentinel, production, runtime logs',
    'Confirm drain retains ≥7 days (prefer 30) searchable JSON lines',
    'Re-run: node scripts/a1-log-drain-check.mjs',
    'Only then consider pilot producer; flag-on still needs separate go',
  ],
};

results.pass = results.gate.pass && results.checks.every((c) => c.name === 'retention_sufficient_for_a1_canary' ? c.ok : true);

// Gate pass is drain-centric
results.pass = results.gate.pass;

const out = join(OUT_DIR, `a1-log-drain-check-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ pass: results.pass, gate: results.gate, out }, null, 2));
process.exit(results.pass ? 0 : 1);
