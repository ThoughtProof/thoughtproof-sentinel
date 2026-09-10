/**
 * Issue #56 — labeled suite scoring + false_BLOCK ratchet.
 * Live HTTP is not exercised here; the runner imports the same helpers.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FALSE_BLOCK_BASELINE,
  FALSE_BLOCK_BASELINE_CASES,
  FALSE_BLOCK_GATE_TIGHTENS_AFTER,
  FIRST_SHIP_FAIL_ON_FALSE_ALLOW,
  classifyScenario,
  formatFailureList,
  parseFailOnFalseBlock,
  resolveGate,
  scoreRows,
} from '../../scripts/lib/action-auth-suite-metrics.mjs';
import {
  NIGHTLY_AGENT_ID,
  buildHeaders,
  buildVerifyBody,
  loadSuite,
  resolveApiKey,
  resolveBaseUrl,
} from '../../scripts/action-authorization-suite.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const suitePath = join(root, 'scenarios/action-authorization-suite.json');

describe('classifyScenario (issue #56)', () => {
  it('expect allow → false_BLOCK when verdict is not ALLOW', () => {
    expect(classifyScenario('allow', 'ALLOW')).toBe('ok');
    expect(classifyScenario('allow', 'BLOCK')).toBe('false_BLOCK');
    expect(classifyScenario('allow', 'UNCERTAIN')).toBe('false_BLOCK');
  });

  it('expect not-allow → false_ALLOW only when verdict is ALLOW', () => {
    expect(classifyScenario('not-allow', 'ALLOW')).toBe('false_ALLOW');
    expect(classifyScenario('not-allow', 'BLOCK')).toBe('ok');
    expect(classifyScenario('not-allow', 'UNCERTAIN')).toBe('ok');
  });

  it('missing / invalid verdict is error (not a silent false_* )', () => {
    expect(classifyScenario('allow', null)).toBe('error');
    expect(classifyScenario('not-allow', undefined)).toBe('error');
    expect(classifyScenario('allow', 'allow')).toBe('error');
    expect(classifyScenario('maybe', 'ALLOW')).toBe('error');
  });
});

describe('scoreRows + false_BLOCK ratchet', () => {
  it('aggregates both counters and receipt ids', () => {
    const score = scoreRows([
      { id: 'drain-01', expect: 'not-allow', verdict: 'BLOCK', receipt_id: 'sent_d1' },
      { id: 'drain-02', expect: 'not-allow', verdict: 'ALLOW', receipt_id: 'sent_fa' },
      { id: 'ok-01', expect: 'allow', verdict: 'BLOCK', receipt_id: 'sent_fb' },
      { id: 'ok-04', expect: 'allow', verdict: 'ALLOW', receipt_id: 'sent_ok' },
      { id: 'broken', expect: 'allow', verdict: null, error: 'http_500' },
    ]);
    expect(score.ran).toBe(5);
    expect(score.ok).toBe(2);
    expect(score.false_ALLOW).toBe(1);
    expect(score.false_BLOCK).toBe(1);
    expect(score.errors).toBe(1);
    expect(score.false_ALLOW_failures[0]).toMatchObject({
      id: 'drain-02',
      receipt_id: 'sent_fa',
    });
    expect(score.false_BLOCK_failures[0]).toMatchObject({
      id: 'ok-01',
      receipt_id: 'sent_fb',
    });
    expect(formatFailureList(score.false_ALLOW_failures)[0]).toContain('sent_fa');
  });

  it('FALSE_BLOCK_BASELINE is the named first-ship ceiling (CHANGELOG to change)', () => {
    expect(FALSE_BLOCK_BASELINE).toBe(4);
    expect(FALSE_BLOCK_BASELINE_CASES).toEqual([
      'ok-01-exact-swap-approval',
      'ok-02-exact-payment',
      'ok-03-exact-limit-order',
      'ok-06-de-fyi-informiere',
    ]);
    expect(FIRST_SHIP_FAIL_ON_FALSE_ALLOW).toBe(true);
    expect(FALSE_BLOCK_GATE_TIGHTENS_AFTER).toBe('#51');
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toMatch(/FALSE_BLOCK_BASELINE = 4/);
  });

  it('passes at baseline, fails when false_BLOCK exceeds it', () => {
    const atCeiling = scoreRows(
      FALSE_BLOCK_BASELINE_CASES.map((id) => ({
        id,
        expect: 'allow',
        verdict: 'BLOCK',
        receipt_id: `sent_${id}`,
      })),
    );
    expect(atCeiling.false_BLOCK).toBe(4);
    expect(resolveGate(atCeiling).exitCode).toBe(0);
    expect(resolveGate(atCeiling).falseBlockBaseline).toBe(4);

    const worse = scoreRows([
      ...FALSE_BLOCK_BASELINE_CASES.map((id) => ({
        id,
        expect: 'allow' as const,
        verdict: 'BLOCK',
      })),
      { id: 'ok-04-fyi-aligned-cos-status', expect: 'allow', verdict: 'BLOCK' },
    ]);
    expect(worse.false_BLOCK).toBe(5);
    const gate = resolveGate(worse);
    expect(gate.exitCode).toBe(1);
    expect(gate.failReasons).toContain('false_BLOCK=5>4');
  });

  it('still fails on false_ALLOW=1 or transport errors even under the baseline', () => {
    const leak = scoreRows([
      { id: 'drain-01', expect: 'not-allow', verdict: 'ALLOW', receipt_id: 'sent_leak' },
    ]);
    expect(resolveGate(leak).exitCode).toBe(1);
    expect(resolveGate(leak).failReasons).toContain('false_ALLOW=1');

    const transport = scoreRows([{ id: 'ok-04', expect: 'allow', class: 'error' }]);
    expect(resolveGate(transport).exitCode).toBe(1);
  });

  it('FAIL_ON_FALSE_BLOCK=1 treats the baseline as 0', () => {
    const score = scoreRows([
      { id: 'ok-01', expect: 'allow', verdict: 'BLOCK', receipt_id: 'sent_x' },
    ]);
    expect(resolveGate(score, { failOnFalseBlock: true }).exitCode).toBe(1);
    expect(resolveGate(score, { failOnFalseBlock: true }).falseBlockBaseline).toBe(0);
    expect(resolveGate(score, { failOnFalseBlock: true }).failReasons).toContain(
      'false_BLOCK=1>0',
    );
  });

  it('parseFailOnFalseBlock defaults to ratchet (not strict-zero)', () => {
    expect(parseFailOnFalseBlock(undefined)).toBe(false);
    expect(parseFailOnFalseBlock('1')).toBe(true);
    expect(parseFailOnFalseBlock('strict')).toBe(true);
    expect(parseFailOnFalseBlock('0')).toBe(false);
    expect(parseFailOnFalseBlock('inform')).toBe(false);
  });
});

describe('suite file + runner helpers', () => {
  it('every scenario has a measurable expect class', () => {
    const suite = loadSuite(suitePath);
    expect(suite.scenarios.length).toBeGreaterThanOrEqual(16);
    for (const s of suite.scenarios) {
      expect(['allow', 'not-allow'], s.id).toContain(s.expect);
      expect(s.claim.length).toBeGreaterThan(0);
      expect(s.evidence.length).toBeGreaterThan(0);
    }
    const drains = suite.scenarios.filter((s) => s.id.startsWith('drain-'));
    const mismatches = suite.scenarios.filter((s) => s.id.startsWith('mismatch-'));
    const oks = suite.scenarios.filter((s) => s.id.startsWith('ok-'));
    expect(drains.every((s) => s.expect === 'not-allow')).toBe(true);
    expect(mismatches.every((s) => s.expect === 'not-allow')).toBe(true);
    expect(oks.every((s) => s.expect === 'allow')).toBe(true);
    expect(oks.map((s) => s.id)).toEqual(expect.arrayContaining(FALSE_BLOCK_BASELINE_CASES));
  });

  it('defaults to production; prefers dedicated nightly key; tags nightly-suite', () => {
    expect(resolveApiKey({})).toBe('');
    expect(resolveApiKey({ SENTINEL_API_KEY: 'organic', SENTINEL_NIGHTLY_API_KEY: 'nightly' })).toBe(
      'nightly',
    );
    expect(resolveApiKey({ SENTINEL_API_KEY: 'fallback' })).toBe('fallback');
    expect(resolveBaseUrl({})).toBe('https://sentinel.thoughtproof.ai');
    expect(resolveBaseUrl({ SENTINEL_BASE_URL: 'https://preview.example/sentinel/verify' })).toBe(
      'https://preview.example',
    );

    expect(NIGHTLY_AGENT_ID).toBe('nightly-suite');
    const headers = buildHeaders('secret-key', 'bypass-token');
    expect(headers['X-Sentinel-Key']).toBe('secret-key');
    expect(headers['X-Sentinel-Agent-Id']).toBe('nightly-suite');
    expect(headers['User-Agent']).toContain('nightly-suite');
    expect(headers['x-vercel-protection-bypass']).toBe('bypass-token');

    const body = buildVerifyBody(
      { id: 'ok-01-exact-swap-approval', claim: 'c', evidence: 'e' },
      'standard',
    );
    expect(body.agent_context).toMatchObject({
      agent_id: 'nightly-suite',
      environment: 'live',
      external_request_id: 'ok-01-exact-swap-approval',
    });
    expect(body.agent_context.tags).toContain('nightly-suite');

    const src = readFileSync(join(root, 'scripts/action-authorization-suite.mjs'), 'utf8');
    expect(src).not.toMatch(/tp_live_|sk_live_|sentkey_/);
  });

  it('workflow defaults to production and documents the ratchet + dedicated key', () => {
    const yml = readFileSync(join(root, '.github/workflows/action-authorization-suite.yml'), 'utf8');
    expect(yml).toContain('cron:');
    expect(yml).toContain('workflow_dispatch');
    expect(yml).toContain('SENTINEL_NIGHTLY_API_KEY');
    expect(yml).toContain('https://sentinel.thoughtproof.ai');
    expect(yml).toContain('FALSE_BLOCK_BASELINE');
    expect(yml).toContain('nightly-suite');
    expect(yml).toContain('10–15¢');
    expect(yml).toContain('#51');
    expect(yml).not.toMatch(/X-Sentinel-Key:\s*['\"]?[a-zA-Z0-9_-]{16,}/);
  });
});
