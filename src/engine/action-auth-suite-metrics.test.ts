/**
 * Issue #56 — labeled suite scoring + first-ship gate (policy b).
 * Live HTTP is not exercised here; the runner imports the same helpers.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FALSE_BLOCK_GATE_TIGHTENS_AFTER,
  FIRST_SHIP_FAIL_ON_FALSE_ALLOW,
  FIRST_SHIP_FAIL_ON_FALSE_BLOCK,
  classifyScenario,
  formatFailureList,
  parseFailOnFalseBlock,
  resolveGate,
  scoreRows,
} from '../../scripts/lib/action-auth-suite-metrics.mjs';
import { loadSuite, resolveApiKey, resolveBaseUrl, buildHeaders } from '../../scripts/action-authorization-suite.mjs';

const suitePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../scenarios/action-authorization-suite.json',
);

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

describe('scoreRows + first-ship gate (policy b)', () => {
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

  it('first ship fails on false_ALLOW and errors, not on false_BLOCK', () => {
    expect(FIRST_SHIP_FAIL_ON_FALSE_ALLOW).toBe(true);
    expect(FIRST_SHIP_FAIL_ON_FALSE_BLOCK).toBe(false);
    expect(FALSE_BLOCK_GATE_TIGHTENS_AFTER).toBe('#51');

    const knownCascadeFalseBlock = scoreRows([
      { id: 'ok-01', expect: 'allow', verdict: 'BLOCK', receipt_id: 'sent_a' },
      { id: 'ok-02', expect: 'allow', verdict: 'BLOCK', receipt_id: 'sent_b' },
      { id: 'ok-03', expect: 'allow', verdict: 'UNCERTAIN', receipt_id: 'sent_c' },
      { id: 'drain-01', expect: 'not-allow', verdict: 'BLOCK', receipt_id: 'sent_d' },
    ]);
    expect(knownCascadeFalseBlock.false_BLOCK).toBe(3);
    expect(knownCascadeFalseBlock.false_ALLOW).toBe(0);
    expect(resolveGate(knownCascadeFalseBlock).exitCode).toBe(0);
    expect(resolveGate(knownCascadeFalseBlock).failReasons).toEqual([]);

    const leak = scoreRows([
      { id: 'drain-01', expect: 'not-allow', verdict: 'ALLOW', receipt_id: 'sent_leak' },
    ]);
    expect(resolveGate(leak).exitCode).toBe(1);
    expect(resolveGate(leak).failReasons).toContain('false_ALLOW=1');

    const transport = scoreRows([{ id: 'ok-04', expect: 'allow', class: 'error' }]);
    expect(resolveGate(transport).exitCode).toBe(1);
  });

  it('FAIL_ON_FALSE_BLOCK=1 tightens the dual threshold', () => {
    const score = scoreRows([
      { id: 'ok-01', expect: 'allow', verdict: 'BLOCK', receipt_id: 'sent_x' },
    ]);
    expect(resolveGate(score, { failOnFalseBlock: true }).exitCode).toBe(1);
    expect(resolveGate(score, { failOnFalseBlock: true }).failReasons).toContain(
      'false_BLOCK=1',
    );
  });

  it('parseFailOnFalseBlock defaults to first-ship inform', () => {
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
    expect(oks.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        'ok-01-exact-swap-approval',
        'ok-02-exact-payment',
        'ok-03-exact-limit-order',
      ]),
    );
  });

  it('does not hardcode keys; builds X-Sentinel-Key + optional bypass', () => {
    expect(resolveApiKey({})).toBe('');
    expect(resolveApiKey({ SENTINEL_API_KEY: 'k1' })).toBe('k1');
    expect(resolveBaseUrl({})).toBe('https://sentinel.thoughtproof.ai');
    expect(resolveBaseUrl({ SENTINEL_BASE_URL: 'https://preview.example/sentinel/verify' })).toBe(
      'https://preview.example',
    );
    const headers = buildHeaders('secret-key', 'bypass-token');
    expect(headers['X-Sentinel-Key']).toBe('secret-key');
    expect(headers['x-vercel-protection-bypass']).toBe('bypass-token');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../scripts/action-authorization-suite.mjs'),
      'utf8',
    );
    expect(src).not.toMatch(/tp_live_|sk_live_|sentkey_/);
  });

  it('workflow is cron + dispatch and documents first-ship gate + secrets', () => {
    const yml = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows/action-authorization-suite.yml'),
      'utf8',
    );
    expect(yml).toContain('cron:');
    expect(yml).toContain('workflow_dispatch');
    expect(yml).toContain('SENTINEL_API_KEY');
    expect(yml).toContain('VERCEL_AUTOMATION_BYPASS_SECRET');
    expect(yml).toContain('FAIL_ON_FALSE_BLOCK');
    expect(yml).toContain('false_ALLOW');
    expect(yml).toContain('#51');
    expect(yml).not.toMatch(/X-Sentinel-Key:\s*['\"]?[a-zA-Z0-9_-]{16,}/);
  });
});
