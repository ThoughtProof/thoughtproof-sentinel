#!/usr/bin/env node
/**
 * Live runner for scenarios/action-authorization-suite.json (issue #56).
 *
 *   SENTINEL_NIGHTLY_API_KEY=… \
 *     node scripts/action-authorization-suite.mjs
 *
 * Defaults to production https://sentinel.thoughtproof.ai (~15–20¢/night
 * at standard: 23 × $0.008). Preview is an optional override for
 * PR / workflow_dispatch only (SENTINEL_BASE_URL).
 *
 * Dedicated key: prefer SENTINEL_NIGHTLY_API_KEY (not a customer key).
 * Every request sets X-Sentinel-Agent-Id + agent_context.agent_id =
 * `nightly-suite` so billing events and verify logs (`agent=`) can
 * filter these 23 runs away from organic traffic.
 *
 * Optional:
 *   SENTINEL_TIER                 default standard
 *   FAIL_ON_FALSE_BLOCK=1         treat FALSE_BLOCK_BASELINE as 0
 *   VERCEL_AUTOMATION_BYPASS_SECRET  only if overriding to protected Preview
 *   --dry-run                     load + print plan, no HTTP
 *
 * Auth header is X-Sentinel-Key. Do not hardcode keys.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  FALSE_BLOCK_BASELINE,
  classifyScenario,
  formatFailureList,
  listOverdueKnownFalseBlocks,
  parseFailOnFalseBlock,
  parseIsoDate,
  resolveGate,
  scoreRows,
} from './lib/action-auth-suite-metrics.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SUITE = join(ROOT, 'scenarios', 'action-authorization-suite.json');
const DEFAULT_BASE = 'https://sentinel.thoughtproof.ai';
const DEFAULT_TIER = 'standard';
const MODE = 'action_authorization';

/** Billing + verify-log agent= and receipt agent_context.agent_id. */
export const NIGHTLY_AGENT_ID = 'nightly-suite';

export function resolveApiKey(env = process.env) {
  return (
    env.SENTINEL_NIGHTLY_API_KEY ||
    env.SENTINEL_API_KEY ||
    env.X_SENTINEL_KEY ||
    env.SENTINEL_TEST_KEY ||
    env.TP_API_KEY ||
    env.THOUGHTPROOF_API_KEY ||
    ''
  );
}

export function resolveBaseUrl(env = process.env) {
  const raw = env.SENTINEL_BASE_URL || env.SENTINEL_URL || DEFAULT_BASE;
  return raw.replace(/\/sentinel\/verify\/?$/, '').replace(/\/$/, '');
}

export function resolveBypass(env = process.env) {
  return env.VERCEL_AUTOMATION_BYPASS_SECRET || env.VERCEL_PROTECTION_BYPASS || '';
}

export function loadSuite(path = DEFAULT_SUITE) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
    throw new Error(`suite has no scenarios: ${path}`);
  }
  for (const s of parsed.scenarios) {
    if (!s.id || (s.expect !== 'allow' && s.expect !== 'not-allow')) {
      throw new Error(`invalid scenario ${JSON.stringify(s.id)} expect=${s.expect}`);
    }
    if (s.known_false_block != null && typeof s.known_false_block !== 'boolean') {
      throw new Error(`scenario ${s.id} known_false_block must be boolean`);
    }
    if (s.known_false_block === true && !parseIsoDate(s.since)) {
      throw new Error(
        `scenario ${s.id} known_false_block requires since as ISO date (YYYY-MM-DD)`,
      );
    }
    if (typeof s.claim !== 'string' || typeof s.evidence !== 'string') {
      throw new Error(`scenario ${s.id} missing claim/evidence`);
    }
  }
  return parsed;
}

export function buildHeaders(key, bypass) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Sentinel-Key': key,
    // BillingEvent.agent_id + verify log `agent=` (api/sentinel/verify.ts).
    'X-Sentinel-Agent-Id': NIGHTLY_AGENT_ID,
    'User-Agent': 'thoughtproof-sentinel-nightly-suite/1',
  };
  if (bypass) {
    headers['x-vercel-protection-bypass'] = bypass;
    headers['x-vercel-set-bypass-cookie'] = 'samesitenone';
  }
  return headers;
}

/** Body Sentinel records on the receipt (`meta.agent_context`). */
export function buildVerifyBody(scenario, tier = DEFAULT_TIER) {
  return {
    claim: scenario.claim,
    evidence: scenario.evidence,
    mode: MODE,
    tier,
    agent_context: {
      agent_id: NIGHTLY_AGENT_ID,
      agent_runtime: 'github-actions-nightly',
      environment: 'live',
      tags: ['nightly-suite', 'action-authorization-suite', 'issue-56'],
      external_request_id: scenario.id,
    },
  };
}

function looksLikeVercelProtection(status, contentType, text) {
  if (status === 401 && /text\/html/i.test(contentType || '')) return true;
  if (/Authentication Required|vercel.*login|deployment protection/i.test(text || '')) {
    return true;
  }
  return false;
}

async function postVerify(url, headers, body, { timeoutMs = 90_000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    const contentType = res.headers.get('content-type') || '';
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, contentType, text, json };
  } finally {
    clearTimeout(t);
  }
}

function rowFromResponse(scenario, res) {
  const base = {
    id: scenario.id,
    expect: scenario.expect,
    known_false_block: scenario.known_false_block === true,
    http_status: res.status,
    verdict: res.json?.verdict ?? null,
    receipt_id: res.json?.id ?? null,
    decision_basis: res.json?.meta?.promotion?.decision_basis ?? null,
    promotion_reason: res.json?.meta?.promotion?.reason ?? null,
    mandate_kind: res.json?.meta?.promotion?.mandate_kind ?? null,
    action_kind: res.json?.meta?.promotion?.action_kind ?? null,
    error: null,
  };
  if (looksLikeVercelProtection(res.status, res.contentType, res.text)) {
    return {
      ...base,
      class: 'error',
      error: 'vercel_deployment_protection (set VERCEL_AUTOMATION_BYPASS_SECRET)',
    };
  }
  if (res.status < 200 || res.status >= 300 || !res.json) {
    return {
      ...base,
      class: 'error',
      error: res.json?.error || res.json?.code || `http_${res.status}`,
    };
  }
  return {
    ...base,
    class: classifyScenario(scenario.expect, base.verdict, scenario.known_false_block === true),
  };
}

function printRow(row) {
  const bits = [
    row.id,
    `expect=${row.expect}`,
    row.known_false_block ? 'known_false_block' : null,
    `verdict=${row.verdict ?? '—'}`,
    `class=${row.class}`,
    row.receipt_id ? `receipt=${row.receipt_id}` : null,
    row.decision_basis ? `decision_basis=${row.decision_basis}` : null,
    row.promotion_reason ? `promotion=${row.promotion_reason}` : null,
    row.mandate_kind ? `mandate_kind=${row.mandate_kind}` : null,
    row.action_kind ? `action_kind=${row.action_kind}` : null,
    row.http_status != null ? `http=${row.http_status}` : null,
    row.error ? `error=${row.error}` : null,
  ].filter(Boolean);
  console.log(bits.join('  '));
}

function writeStepSummary(report) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const { score, gate, overdue = [] } = report;
  const lines = [
    '## action_authorization suite',
    '',
    `| metric | count |`,
    `| --- | ---: |`,
    `| ran | ${score.ran} |`,
    `| ok | ${score.ok} |`,
    `| **false_ALLOW** | **${score.false_ALLOW}** |`,
    `| false_BLOCK | ${score.false_BLOCK} |`,
    `| known_false_block | ${score.known_false_block} |`,
    `| errors | ${score.errors} |`,
    '',
    `Gate: false_ALLOW=0 · false_BLOCK≤${gate.falseBlockBaseline} · known_false_block informational → **${gate.exitCode === 0 ? 'PASS' : 'FAIL'}**`,
    '',
  ];
  if (score.false_ALLOW_failures.length) {
    lines.push('### false_ALLOW', '');
    for (const f of formatFailureList(score.false_ALLOW_failures)) lines.push(`- ${f}`);
    lines.push('');
  }
  if (score.false_BLOCK_failures.length) {
    lines.push(`### false_BLOCK (baseline ≤${gate.falseBlockBaseline}; ratchet, not soft-pass)`, '');
    for (const f of formatFailureList(score.false_BLOCK_failures)) lines.push(`- ${f}`);
    lines.push('');
  }
  if (score.known_false_block_failures.length) {
    lines.push('### known_false_block (informational only; not gated)', '');
    for (const f of formatFailureList(score.known_false_block_failures)) lines.push(`- ${f}`);
    lines.push('');
  }
  if (overdue.length) {
    lines.push('### known_false_block overdue (WARN; does not fail the gate)', '');
    for (const o of overdue) lines.push(`- ${o.warn}`);
    lines.push('');
  }
  if (score.error_failures.length) {
    lines.push('### errors', '');
    for (const f of formatFailureList(score.error_failures)) lines.push(`- ${f}`);
    lines.push('');
  }
  writeFileSync(path, `${lines.join('\n')}\n`, { flag: 'a' });
}

export async function runSuite(opts = {}) {
  const env = opts.env ?? process.env;
  const suite = loadSuite(opts.suitePath ?? DEFAULT_SUITE);
  const dryRun = opts.dryRun === true;
  const base = resolveBaseUrl(env);
  const url = `${base}/sentinel/verify`;
  const tier = env.SENTINEL_TIER || DEFAULT_TIER;
  const key = resolveApiKey(env);
  const bypass = resolveBypass(env);
  const failOnFalseBlock = parseFailOnFalseBlock(env.FAIL_ON_FALSE_BLOCK);

  if (dryRun) {
    const plan = suite.scenarios.map((s) => ({
      id: s.id,
      expect: s.expect,
      known_false_block: s.known_false_block === true,
      since: s.known_false_block === true ? s.since : undefined,
    }));
    const overdue = listOverdueKnownFalseBlocks(suite.scenarios);
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          base,
          url,
          tier,
          mode: MODE,
          n: plan.length,
          agent_id: NIGHTLY_AGENT_ID,
          estimated_cost_usd: Number((plan.length * 0.008).toFixed(3)),
          scenarios: plan,
          gate: {
            fail_on_false_ALLOW: true,
            false_BLOCK_baseline: failOnFalseBlock ? 0 : FALSE_BLOCK_BASELINE,
            fail_on_false_BLOCK: failOnFalseBlock,
            false_BLOCK_tightens_after: '#51',
            known_false_block_overdue: overdue.map((o) => o.warn),
          },
        },
        null,
        2,
      ),
    );
    for (const o of overdue) console.warn(o.warn);
    return { dryRun: true, score: emptyish(plan.length), gate: resolveGate({ errors: 0, false_ALLOW: 0, false_BLOCK: 0, known_false_block: 0 }, { failOnFalseBlock }), overdue };
  }

  if (!key) {
    console.error(
      'Set SENTINEL_NIGHTLY_API_KEY (dedicated nightly key) or SENTINEL_API_KEY. Do not hardcode keys.',
    );
    process.exitCode = 2;
    return { missingKey: true };
  }

  const headers = buildHeaders(key, bypass);
  const rows = [];
  for (const scenario of suite.scenarios) {
    let res;
    try {
      const body = buildVerifyBody(scenario, tier);
      res = await postVerify(url, headers, body);
      if ((res.status === 429 || res.status === 503) && res.json) {
        const retryAfter = Number(res.json.retry_after_ms ?? 2000);
        await sleep(Math.min(Math.max(retryAfter, 500), 15_000));
        res = await postVerify(url, headers, body);
      }
    } catch (err) {
      const row = {
        id: scenario.id,
        expect: scenario.expect,
        known_false_block: scenario.known_false_block === true,
        verdict: null,
        receipt_id: null,
        http_status: null,
        class: 'error',
        error: err?.cause?.code || err?.name || 'fetch_error',
      };
      rows.push(row);
      printRow(row);
      continue;
    }
    const row = rowFromResponse(scenario, res);
    rows.push(row);
    printRow(row);
  }

  const score = scoreRows(rows);
  const gate = resolveGate(score, { failOnFalseBlock });
  const overdue = listOverdueKnownFalseBlocks(suite.scenarios);
  const report = {
    ts: new Date().toISOString(),
    base,
    url,
    tier,
    mode: MODE,
    false_ALLOW: score.false_ALLOW,
    false_BLOCK: score.false_BLOCK,
    known_false_block: score.known_false_block,
    errors: score.errors,
    ok: score.ok,
    ran: score.ran,
    false_ALLOW_ids: score.false_ALLOW_failures.map((f) => f.id),
    false_BLOCK_ids: score.false_BLOCK_failures.map((f) => f.id),
    known_false_block_ids: score.known_false_block_failures.map((f) => f.id),
    false_ALLOW_receipts: score.false_ALLOW_failures.map((f) => f.receipt_id).filter(Boolean),
    false_BLOCK_receipts: score.false_BLOCK_failures.map((f) => f.receipt_id).filter(Boolean),
    known_false_block_receipts: score.known_false_block_failures.map((f) => f.receipt_id).filter(Boolean),
    error_ids: score.error_failures.map((f) => f.id),
    agent_id: NIGHTLY_AGENT_ID,
    gate: {
      fail_on_false_ALLOW: gate.failOnFalseAllow,
      false_BLOCK_baseline: gate.falseBlockBaseline,
      fail_on_false_BLOCK: gate.failOnFalseBlock,
      fail_reasons: gate.failReasons,
      exit_code: gate.exitCode,
      first_ship_note:
        `false_ALLOW must be 0. false_BLOCK ratchet: fail if count > ${gate.falseBlockBaseline} (named FALSE_BLOCK_BASELINE; CHANGELOG to change). known_false_block is informational only (issue #64) — do not raise the baseline to hide those fixtures. After seven nights from since, Ship/founder decide: fix the classifier or document as product limitation. Overdue WARN does not fail the gate. After #51 lower false_BLOCK baseline to 0.`,
    },
    known_false_block_overdue: overdue.map((o) => o.warn),
    rows,
    score,
    overdue,
  };

  console.log('');
  console.log(
    `false_ALLOW=${score.false_ALLOW}  false_BLOCK=${score.false_BLOCK}  known_false_block=${score.known_false_block}  errors=${score.errors}  ok=${score.ok}/${score.ran}`,
  );
  if (score.false_ALLOW_failures.length) {
    console.log(`false_ALLOW: ${formatFailureList(score.false_ALLOW_failures).join('; ')}`);
  }
  if (score.false_BLOCK_failures.length) {
    console.log(`false_BLOCK: ${formatFailureList(score.false_BLOCK_failures).join('; ')}`);
  }
  if (score.known_false_block_failures.length) {
    console.log(`known_false_block: ${formatFailureList(score.known_false_block_failures).join('; ')}`);
  }
  for (const o of overdue) {
    console.warn(o.warn);
  }
  if (score.error_failures.length) {
    console.log(`errors: ${formatFailureList(score.error_failures).join('; ')}`);
  }
  console.log(
    `gate false_ALLOW=0 false_BLOCK≤${gate.falseBlockBaseline} known_false_block informational → ${gate.exitCode === 0 ? 'PASS' : 'FAIL'} ${gate.failReasons.join(' ')}`,
  );
  console.log(JSON.stringify({
    false_ALLOW: report.false_ALLOW,
    false_BLOCK: report.false_BLOCK,
    known_false_block: report.known_false_block,
    errors: report.errors,
    false_ALLOW_ids: report.false_ALLOW_ids,
    false_BLOCK_ids: report.false_BLOCK_ids,
    known_false_block_ids: report.known_false_block_ids,
    false_ALLOW_receipts: report.false_ALLOW_receipts,
    false_BLOCK_receipts: report.false_BLOCK_receipts,
    known_false_block_receipts: report.known_false_block_receipts,
    known_false_block_overdue: report.known_false_block_overdue,
    gate: report.gate,
  }));

  writeStepSummary({ score, gate, overdue });
  return report;
}

function emptyish(n) {
  return { ran: n, ok: 0, false_ALLOW: 0, false_BLOCK: 0, known_false_block: 0, errors: 0 };
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const dryRun = process.argv.includes('--dry-run');
  const report = await runSuite({ dryRun });
  if (report?.missingKey) process.exit(2);
  if (dryRun) process.exit(0);
  // report.gate uses snake_case exit_code (see JSON payload above).
  process.exit(report?.gate?.exit_code ?? report?.gate?.exitCode ?? 1);
}
