#!/usr/bin/env node
/**
 * Active rate-limit check (issues #41 / #43).
 *
 * Usage (operator, test key only — never a prod customer key):
 *
 *   SENTINEL_TEST_KEY=… \
 *   SENTINEL_URL=https://sentinel.thoughtproof.ai \
 *   node scripts/rate-limit-burst-check.mjs
 *
 * Default BURST_N is BURST_CHECK_DEFAULT_N from src/rate-limit-policy.json
 * (above AUTHENTICATED_RATE_LIMIT_PER_MINUTE). Expected mix on a healthy
 * Redis limiter, authenticated, invalid-body verify:
 *
 *   ~120 × HTTP 400 (validation after auth + rate-limit)
 *   then HTTP 429 + Retry-After
 *
 * HTTP 503 RATE_LIMIT_UNAVAILABLE means Redis is still broken (fail-closed);
 * that is not a successful limiter dogfood. Capture Retry-After on 429/503.
 *
 * Optional Preview dogfood of the 503 branch (no Production env flip):
 * set a branch-bound invalid UPSTASH_REDIS_REST_TOKEN, redeploy Preview only,
 * expect 503 + Retry-After: 30 and no billing event.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const policy = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rate-limit-policy.json'),
    'utf8',
  ),
);

const url = (process.env.SENTINEL_URL ?? 'https://sentinel.thoughtproof.ai').replace(/\/$/, '');
const key = process.env.SENTINEL_TEST_KEY ?? '';
const n = Number(process.env.BURST_N ?? policy.burstCheckDefaultN);
const windowMs = Number(process.env.BURST_WINDOW_MS ?? 45_000);

if (!key) {
  console.error('Set SENTINEL_TEST_KEY to a non-production test key.');
  process.exit(2);
}

const counts = new Map();
const started = Date.now();
const gap = Math.max(0, Math.floor(windowMs / n));
let first429At;
let first503At;
let retryAfter429;
let retryAfter503;

for (let i = 0; i < n; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${url}/sentinel/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sentinel-key': key,
      },
      // Minimal body — validation may 400 after rate-limit/auth; that is fine.
      body: JSON.stringify({ mode: 'handoff', claim: 'burst-check' }),
    });
    const k = String(res.status);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    const retryAfter = res.headers.get('retry-after');
    if (res.status === 429 && first429At === undefined) {
      first429At = i;
      retryAfter429 = retryAfter;
    }
    if (res.status === 503 && first503At === undefined) {
      first503At = i;
      retryAfter503 = retryAfter;
    }
  } catch (err) {
    const k = `ERR:${err?.cause?.code ?? err?.name ?? 'fetch'}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const elapsed = Date.now() - t0;
  if (i < n - 1 && gap > elapsed) await sleep(gap - elapsed);
}

const elapsedTotal = Date.now() - started;
console.log(
  JSON.stringify(
    {
      url: `${url}/sentinel/verify`,
      n,
      authenticated_limit_per_minute: policy.authenticatedPerMinute,
      window_ms_target: windowMs,
      elapsed_ms: elapsedTotal,
      status_counts: Object.fromEntries([...counts.entries()].sort()),
      first_429_at_index: first429At ?? null,
      first_503_at_index: first503At ?? null,
      retry_after_429: retryAfter429 ?? null,
      retry_after_503: retryAfter503 ?? null,
      saw_503: counts.has('503'),
      expected:
        `~${policy.authenticatedPerMinute} × 400 validation, then 429 + Retry-After. ` +
        '503 RATE_LIMIT_UNAVAILABLE means Redis is still broken (fail-closed).',
    },
    null,
    2,
  ),
);
