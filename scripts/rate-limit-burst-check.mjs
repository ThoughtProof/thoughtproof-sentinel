#!/usr/bin/env node
/**
 * Active rate-limit check for issue #41 criterion 4.
 *
 * Usage (operator, test key only — never a prod customer key):
 *
 *   SENTINEL_TEST_KEY=… \
 *   SENTINEL_URL=https://sentinel.thoughtproof.ai \
 *   node scripts/rate-limit-burst-check.mjs
 *
 * Default: 30 POSTs in ~10s against /sentinel/verify with a minimal invalid
 * body (expects 400 after auth+rate-limit, or 429 when limited). Counts
 * status codes; does not print the key.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const url = (process.env.SENTINEL_URL ?? 'https://sentinel.thoughtproof.ai').replace(/\/$/, '');
const key = process.env.SENTINEL_TEST_KEY ?? '';
const n = Number(process.env.BURST_N ?? 30);
const windowMs = Number(process.env.BURST_WINDOW_MS ?? 10_000);

if (!key) {
  console.error('Set SENTINEL_TEST_KEY to a non-production test key.');
  process.exit(2);
}

const counts = new Map();
const started = Date.now();
const gap = Math.max(0, Math.floor(windowMs / n));

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
      window_ms_target: windowMs,
      elapsed_ms: elapsedTotal,
      status_counts: Object.fromEntries([...counts.entries()].sort()),
      note: 'Expect some 429 once limiter engages; 503 RATE_LIMIT_UNAVAILABLE means Redis path fail-closed.',
    },
    null,
    2,
  ),
);
