#!/usr/bin/env node
/**
 * Read A1 Upstash counters (production). Uses env or optional --env-file=.
 * Does not print secrets.
 */
import { readFileSync, existsSync } from 'node:fs';
import { Redis } from '@upstash/redis';

function loadEnvFile(path) {
  if (!path || !existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    v = v.replace(/\\n/g, '').replace(/\n/g, '').trim();
    if (k && v && !process.env[k]) process.env[k] = v;
  }
}

const envFileArg = process.argv.find((a) => a.startsWith('--env-file='));
if (envFileArg) loadEnvFile(envFileArg.split('=')[1]);
// never commit; local temp pull only
loadEnvFile('/tmp/sentinel-prod-env-check.txt');

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').replace(/\n/g, '').trim();
if (!url || !token) {
  console.log(JSON.stringify({ ok: false, error: 'missing_upstash_env' }));
  process.exit(2);
}

const redis = new Redis({ url, token });
const envName = process.env.SHADOW_SINK_ENV || 'production';
const p = `sentinel:a1:${envName}`;
const total = await redis.get(`${p}:c:total`);
const eligible = await redis.get(`${p}:c:eligible`);
const ok = await redis.get(`${p}:c:ok`);
const error = await redis.get(`${p}:c:error`);
const idxLen = await redis.zcard(`${p}:idx:ts`);
const tail = await redis.zrange(`${p}:idx:ts`, -3, -1);
let sample = null;
if (Array.isArray(tail) && tail.length) {
  const mid = tail[tail.length - 1];
  const raw = await redis.get(`${p}:evt:${mid}`);
  const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (body && typeof body === 'object') {
    sample = {
      event_id: body.event_id,
      type: body.type,
      would_escalate: body.would_escalate,
      source_verdict: body.source_verdict,
      trigger_code: body.trigger_code,
      shadow_status: body.shadow_status,
      binding_source: body.binding_source,
      eligible_for_q2_decision: body.eligible_for_q2_decision,
      sink: body.sink,
      error_code: body.error_code ?? null,
    };
  }
}
console.log(
  JSON.stringify(
    {
      ok: true,
      env: envName,
      counters: { total, eligible, ok, error, idx_len: idxLen },
      sample,
    },
    null,
    2,
  ),
);
