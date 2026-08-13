#!/usr/bin/env node
/**
 * Single controlled A1 pilot producer CLI (pure JS; mirrors src/adr0020/pilot-producer.ts).
 *
 * Default: dry-run (build + local shape checks, no network).
 * --live: POST to Sentinel (never sets SHADOW_ADR0020).
 * --limit=N: max cases (default 3).
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'reports');
mkdirSync(OUT_DIR, { recursive: true });

const PILOT_PRODUCER_ID = 'adr0020.a1.pilot.v0';
const PILOT_MAX_CONDITIONS = 8;
const PILOT_MAX_BINDINGS = 4;
const ACTION_HASH_RE = /^0x[a-f0-9]{64}$/;
const CONDITION_ID_RE = /^[a-z][a-z0-9_]{1,63}$/;
const EVIDENCE_ID_RE = /^evidence:[a-z0-9][a-z0-9_-]{1,63}$/;
const VALID_PROOF = new Set(['machine', 'any', 'none']);
const VALID_FRESHNESS = new Set(['fresh', 'current', 'stale', 'expired', 'unknown']);
const VALID_GRADES = new Set(['machine', 'human', 'unspecified']);

const live = process.argv.includes('--live');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 3) : 3;

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

function canonicalizeActionHash(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return ACTION_HASH_RE.test(t) ? t : null;
}

function deriveActionHash(conditions, caseId) {
  const material = JSON.stringify({
    v: PILOT_PRODUCER_ID,
    case_id: caseId ?? null,
    conditions: conditions.map((c) => ({
      condition_id: c.condition_id,
      required: c.required,
      proof_requirement: c.proof_requirement,
      evidence_bindings: (c.evidence_bindings ?? []).map((b) => ({
        evidence_id: b.evidence_id,
        bound_condition_id: b.bound_condition_id,
        syntactically_valid: b.syntactically_valid,
        freshness: b.freshness,
        contradicted: b.contradicted,
        grade: b.grade,
      })),
    })),
  });
  return `0x${sha256Hex(material)}`;
}

function buildBinding(raw, path, errors, stripped) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ field: path, message: 'Must be an object' });
    return null;
  }
  const allowed = new Set([
    'evidence_id',
    'bound_condition_id',
    'syntactically_valid',
    'freshness',
    'contradicted',
    'grade',
    'valid_bound',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) errors.push({ field: `${path}.${key}`, message: `Unknown field "${key}"` });
  }
  if ('valid_bound' in raw) stripped.push(`${path}.valid_bound`);
  for (const bad of ['raw', 'content', 'text', 'payload', 'secret', 'pii']) {
    if (bad in raw) errors.push({ field: `${path}.${bad}`, message: 'Raw/PII fields forbidden' });
  }
  if (typeof raw.evidence_id !== 'string' || !EVIDENCE_ID_RE.test(raw.evidence_id)) {
    errors.push({ field: `${path}.evidence_id`, message: 'Invalid evidence_id' });
    return null;
  }
  if (typeof raw.bound_condition_id !== 'string' || !CONDITION_ID_RE.test(raw.bound_condition_id)) {
    errors.push({ field: `${path}.bound_condition_id`, message: 'Invalid bound_condition_id' });
    return null;
  }
  if (typeof raw.syntactically_valid !== 'boolean') {
    errors.push({ field: `${path}.syntactically_valid`, message: 'Must be boolean' });
    return null;
  }
  if (typeof raw.freshness !== 'string' || !VALID_FRESHNESS.has(raw.freshness)) {
    errors.push({ field: `${path}.freshness`, message: 'Invalid freshness' });
    return null;
  }
  if (typeof raw.contradicted !== 'boolean') {
    errors.push({ field: `${path}.contradicted`, message: 'Must be boolean' });
    return null;
  }
  if (typeof raw.grade !== 'string' || !VALID_GRADES.has(raw.grade)) {
    errors.push({ field: `${path}.grade`, message: 'Invalid grade' });
    return null;
  }
  return {
    evidence_id: raw.evidence_id,
    bound_condition_id: raw.bound_condition_id,
    syntactically_valid: raw.syntactically_valid,
    freshness: raw.freshness,
    contradicted: raw.contradicted,
    grade: raw.grade,
  };
}

function buildCondition(raw, path, errors, stripped, seen) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ field: path, message: 'Must be an object' });
    return null;
  }
  const allowed = new Set([
    'condition_id',
    'required',
    'proof_requirement',
    'evidence_bindings',
    'valid_bound_evidence_count',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) errors.push({ field: `${path}.${key}`, message: `Unknown field "${key}"` });
  }
  if ('valid_bound_evidence_count' in raw) stripped.push(`${path}.valid_bound_evidence_count`);
  if (typeof raw.condition_id !== 'string' || !CONDITION_ID_RE.test(raw.condition_id)) {
    errors.push({ field: `${path}.condition_id`, message: 'Invalid condition_id' });
    return null;
  }
  if (seen.has(raw.condition_id)) {
    errors.push({ field: `${path}.condition_id`, message: `duplicate condition_id "${raw.condition_id}"` });
    return null;
  }
  seen.add(raw.condition_id);
  if (typeof raw.required !== 'boolean') {
    errors.push({ field: `${path}.required`, message: 'Must be boolean' });
    return null;
  }
  if (typeof raw.proof_requirement !== 'string' || !VALID_PROOF.has(raw.proof_requirement)) {
    errors.push({ field: `${path}.proof_requirement`, message: 'Must be machine|any|none' });
    return null;
  }
  let evidence_bindings;
  if (raw.evidence_bindings !== undefined) {
    if (!Array.isArray(raw.evidence_bindings)) {
      errors.push({ field: `${path}.evidence_bindings`, message: 'Must be an array' });
      return null;
    }
    if (raw.evidence_bindings.length > PILOT_MAX_BINDINGS) {
      errors.push({
        field: `${path}.evidence_bindings`,
        message: `Exceeds pilot max ${PILOT_MAX_BINDINGS}`,
      });
      return null;
    }
    evidence_bindings = [];
    for (let j = 0; j < raw.evidence_bindings.length; j++) {
      const b = buildBinding(
        raw.evidence_bindings[j],
        `${path}.evidence_bindings[${j}]`,
        errors,
        stripped,
      );
      if (b) evidence_bindings.push(b);
    }
  }
  return {
    condition_id: raw.condition_id,
    required: raw.required,
    proof_requirement: raw.proof_requirement,
    ...(evidence_bindings ? { evidence_bindings } : {}),
  };
}

function buildPilotVerifyRequest(input) {
  const errors = [];
  const stripped = [];
  const caseId =
    typeof input.case_id === 'string' && input.case_id.trim() ? input.case_id.trim() : null;

  if (input.required_conditions === undefined) {
    errors.push({ field: 'required_conditions', message: 'Required for pilot producer' });
  } else if (!Array.isArray(input.required_conditions)) {
    errors.push({ field: 'required_conditions', message: 'Must be an array' });
  } else if (input.required_conditions.length === 0) {
    errors.push({ field: 'required_conditions', message: 'Must be non-empty for pilot' });
  } else if (input.required_conditions.length > PILOT_MAX_CONDITIONS) {
    errors.push({
      field: 'required_conditions',
      message: `Exceeds pilot max ${PILOT_MAX_CONDITIONS}`,
    });
  }

  const seen = new Set();
  const conditions = [];
  if (Array.isArray(input.required_conditions)) {
    for (let i = 0; i < input.required_conditions.length && i < PILOT_MAX_CONDITIONS; i++) {
      const c = buildCondition(
        input.required_conditions[i],
        `required_conditions[${i}]`,
        errors,
        stripped,
        seen,
      );
      if (c) conditions.push(c);
    }
  }

  let action_hash = canonicalizeActionHash(input.action_hash);
  if (input.action_hash !== undefined && action_hash === null) {
    errors.push({
      field: 'action_hash',
      message: 'Must be 0x followed by exactly 64 hex characters',
    });
  }
  if (action_hash === null && conditions.length > 0 && errors.length === 0) {
    action_hash = deriveActionHash(conditions, caseId);
  }

  const claim = `A1 pilot structure probe${caseId ? ` ${caseId}` : ''}`;
  const evidence = 'synthetic structure-only pilot evidence; no raw mandate';

  const binding_count = conditions.reduce((n, c) => n + (c.evidence_bindings?.length ?? 0), 0);
  const meta = {
    producer_id: PILOT_PRODUCER_ID,
    case_id: caseId,
    condition_count: conditions.length,
    binding_count,
    action_hash,
    stripped_fields: stripped,
  };

  if (errors.length > 0 || !action_hash) {
    if (!action_hash && errors.length === 0) {
      errors.push({ field: 'action_hash', message: 'Could not canonicalize or derive' });
    }
    return { status: 'invalid', errors, meta };
  }

  return {
    status: 'ok',
    errors: [],
    meta,
    request: {
      id: caseId ? `pilot_${caseId}` : undefined,
      claim,
      evidence,
      mode: 'action_authorization',
      tier: 'swift',
      action_hash,
      required_conditions: conditions,
      agent_context: {
        agent_id: PILOT_PRODUCER_ID,
        agent_runtime: 'a1-pilot',
        environment: 'paper',
        tags: [
          'adr0020',
          'a1-pilot',
          'caller_asserted',
          'flag_off_safe',
          ...(caseId ? [`case:${caseId}`] : []),
        ],
      },
    },
  };
}

function measurementLineToPilotInput(line) {
  if (!line || typeof line !== 'object') return {};
  return {
    case_id: typeof line.case_id === 'string' ? line.case_id : undefined,
    action_hash: typeof line.action_hash === 'string' ? line.action_hash : undefined,
    required_conditions: line.required_conditions,
  };
}

/** Local shape checks mirroring server acceptance (subset). */
function localValidate(req) {
  const errors = [];
  if (!req || typeof req !== 'object') return { valid: false, errors: [{ field: 'body', message: 'not object' }] };
  if (typeof req.claim !== 'string' || !req.claim.trim()) errors.push({ field: 'claim', message: 'required' });
  if (typeof req.evidence !== 'string' || !req.evidence.trim()) errors.push({ field: 'evidence', message: 'required' });
  if (!ACTION_HASH_RE.test(String(req.action_hash || '').toLowerCase())) {
    errors.push({ field: 'action_hash', message: 'canonical required' });
  }
  if (!Array.isArray(req.required_conditions) || req.required_conditions.length === 0) {
    errors.push({ field: 'required_conditions', message: 'required non-empty' });
  }
  const s = JSON.stringify(req);
  if (/valid_bound_evidence_count|"valid_bound":/.test(s)) {
    errors.push({ field: 'body', message: 'untrusted count fields must be stripped' });
  }
  if (/"shadow"|would_escalate/.test(s)) {
    errors.push({ field: 'body', message: 'shadow fields must not be in request' });
  }
  return { valid: errors.length === 0, errors };
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const raw = s.startsWith('export ') ? s.slice(7) : s;
    const i = raw.indexOf('=');
    if (i < 0) continue;
    const k = raw.slice(0, i).trim();
    let v = raw.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
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
  join(process.env.HOME || '', 'PROJECTS/ThoughtProof/verified-wallet-agent/.env'),
  join(process.env.HOME || '', 'PROJECTS/ThoughtProof/openserv-sentinel/.env'),
  join(process.env.HOME || '', 'PROJECTS/ThoughtProof/verified-trading-agent/.env'),
]) {
  loadEnvFile(f);
}

const PACK_CANDIDATES = [
  join(
    ROOT,
    '../docs/experiments/e4-external-v0.2/product_run/out/adr0020_measurement_pack_v0/measurement/cases.jsonl',
  ),
  join(
    process.env.HOME || '',
    'PROJECTS/ThoughtProof/docs/experiments/e4-external-v0.2/product_run/out/adr0020_measurement_pack_v0/measurement/cases.jsonl',
  ),
];
const packPath = PACK_CANDIDATES.find((p) => existsSync(p));
if (!packPath) {
  console.error('measurement pack cases.jsonl not found');
  process.exit(2);
}

const BASE =
  process.env.SENTINEL_URL?.replace(/\/sentinel\/verify$/, '') || 'https://sentinel.thoughtproof.ai';
const key =
  process.env.SENTINEL_API_KEY ||
  process.env.X_SENTINEL_KEY ||
  process.env.TP_API_KEY ||
  process.env.THOUGHTPROOF_API_KEY ||
  '';

const lines = readFileSync(packPath, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .slice(0, limit)
  .map((l) => JSON.parse(l));

const results = [];
for (const line of lines) {
  const input = measurementLineToPilotInput(line);
  const built = buildPilotVerifyRequest(input);
  const row = {
    case_id: input.case_id ?? null,
    build_status: built.status,
    errors: built.errors,
    meta: built.meta,
    validation: null,
    http: null,
  };
  if (built.status === 'ok' && built.request) {
    row.validation = localValidate(built.request);
    if (live) {
      if (!key) row.http = { error: 'missing_api_key' };
      else if (!row.validation.valid) row.http = { error: 'local_validation_failed' };
      else {
        const res = await fetch(`${BASE}/sentinel/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sentinel-Key': key,
          },
          body: JSON.stringify(built.request),
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* raw */
        }
        row.http = {
          status: res.status,
          verdict: json?.verdict ?? null,
          id: json?.id ?? null,
          has_shadow_field: json ? Object.prototype.hasOwnProperty.call(json, 'shadow') : null,
        };
      }
    }
  }
  results.push(row);
  console.log(
    JSON.stringify({
      case_id: row.case_id,
      build: row.build_status,
      validation: row.validation?.valid ?? null,
      stripped: row.meta?.stripped_fields?.length ?? 0,
      http: row.http,
    }),
  );
}

const report = {
  ts: new Date().toISOString(),
  producer: PILOT_PRODUCER_ID,
  mode: live ? 'live' : 'dry-run',
  base: BASE,
  pack: packPath,
  limit,
  flag: 'SHADOW_ADR0020 not set by this producer',
  results,
  pass: results.every(
    (r) =>
      r.build_status === 'ok' &&
      r.validation?.valid === true &&
      (!live ||
        (r.http &&
          r.http.status >= 200 &&
          r.http.status < 300 &&
          r.http.has_shadow_field === false)),
  ),
};

const out = join(OUT_DIR, `a1-pilot-producer-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ pass: report.pass, out, mode: report.mode, n: results.length }, null, 2));
process.exit(report.pass ? 0 : 1);
