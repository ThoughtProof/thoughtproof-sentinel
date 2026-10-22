import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error The existing JavaScript runner has no declaration file.
import { loadSuite, runSuite } from '../scripts/action-authorization-suite.mjs';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('nightly receipt retention (offline synthetic responses)', () => {
  let directory: string;
  let suitePath: string;
  let reportPath: string;
  const fetchMock = vi.fn<typeof fetch>();
  const positiveIds = ['ok-04-fyi-aligned-cos-status', 'kfb-01-de-fyi-after-deploy'];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'action-auth-report-'));
    suitePath = join(directory, 'suite.json');
    reportPath = join(directory, 'report.json');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function fixtures(ids = positiveIds) {
    const scenarios = ids.map(id => {
      const scenario = loadSuite().scenarios.find((s: { id: string }) => s.id === id);
      expect(scenario, id).toBeDefined();
      return scenario;
    });
    writeFileSync(suitePath, JSON.stringify({ scenarios }, null, 2) + '\n');
    return scenarios;
  }

  function env(capture = true) {
    return {
      SENTINEL_NIGHTLY_API_KEY: 'offline-api-key-must-not-be-retained',
      VERCEL_AUTOMATION_BYPASS_SECRET: 'offline-bypass-must-not-be-retained',
      SENTINEL_BASE_URL: 'https://offline.invalid',
      SENTINEL_TIER: 'standard',
      GITHUB_SHA: 'synthetic-suite-commit',
      GITHUB_RUN_ID: 'synthetic-run',
      ...(capture ? { ACTION_AUTH_SUITE_REPORT_PATH: reportPath } : {}),
    };
  }

  function receipt(verdict = 'BLOCK') {
    return {
      id: `synthetic_${verdict.toLowerCase()}`,
      verdict,
      confidence: 0.25,
      reasoning: 'Synthetic diagnostic response; not a historical receipt.',
      objections: [{ step_id: 'step_2', predicate: 'unsupported', score: 0.25,
        quote: 'Nach dem Deploy\ninformiere QA', reasoning: 'Synthetic step reason.' }],
      meta: {
        models_used: ['serv-nano'],
        promotion: {
          reason: verdict === 'ALLOW' ? 'already_allow' : 'already_block',
          cascade_reason: verdict === 'ALLOW' ? 'agreement_allow' : 'primary_block',
          decision_basis: 'cascade',
          mandate_kind: 'informational', action_kind: 'informational',
          release_id: 'synthetic-server-commit',
        },
      },
    };
  }

  function respond(body: unknown) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  }

  it('retains full success and failure receipts with fixture/request identity while the baseline gate still fails', async () => {
    const scenarios = fixtures();
    const receipts = [receipt('ALLOW'), receipt('BLOCK')];
    receipts.forEach(respond);
    const report = await runSuite({ suitePath, env: env() });
    expect(report).toMatchObject({ false_ALLOW: 0, false_BLOCK: 1, errors: 0,
      gate: { false_BLOCK_baseline: 0, exit_code: 1, fail_reasons: ['false_BLOCK=1>0'] } });
    const saved = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(saved.rows.map((row: { class: string }) => row.class)).toEqual(['ok', 'false_BLOCK']);
    expect(saved.diagnostics).toMatchObject({
      schema: 'sentinel.action-auth-suite.diagnostics.v1',
      suite_commit: 'synthetic-suite-commit', workflow_run_id: 'synthetic-run',
      fixture_sha256: sha256(readFileSync(suitePath, 'utf8')),
      suite: { scenarios },
    });
    expect(saved.diagnostics.cases).toEqual(receipts.map((response, i) => ({
      id: positiveIds[i], http_status: 200,
      request_sha256: sha256(String(fetchMock.mock.calls[i]![1]!.body)), receipt: response,
    })));
    const bytes = readFileSync(reportPath, 'utf8');
    expect(bytes).not.toContain(env().SENTINEL_NIGHTLY_API_KEY);
    expect(bytes).not.toContain(env().VERCEL_AUTOMATION_BYPASS_SECRET);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retains an unsafe ALLOW and never hides the false_ALLOW failure', async () => {
    fixtures(['drain-02-injected-recipient']);
    const unsafe = receipt('ALLOW');
    respond(unsafe);
    const report = await runSuite({ suitePath, env: env() });
    expect(report).toMatchObject({ false_ALLOW: 1, false_BLOCK: 0,
      gate: { false_BLOCK_baseline: 0, exit_code: 1, fail_reasons: ['false_ALLOW=1'] } });
    const saved = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(saved.diagnostics.cases[0].receipt).toEqual(unsafe);
    expect(saved.rows[0].class).toBe('false_ALLOW');
  });

  it('records transport failure and degraded receipts without turning errors into classifier misses', async () => {
    fixtures();
    fetchMock.mockRejectedValueOnce(new Error('synthetic transport error'));
    const degraded = receipt('BLOCK');
    degraded.meta.promotion.reason = 'engine_budget_exhausted';
    respond(degraded);
    const report = await runSuite({ suitePath, env: env() });
    expect(report).toMatchObject({ false_ALLOW: 0, false_BLOCK: 0, errors: 2,
      gate: { false_BLOCK_baseline: 0, exit_code: 1 } });
    const saved = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(saved.rows.map((row: { class: string }) => row.class)).toEqual(['error', 'error']);
    expect(saved.diagnostics.cases[0]).toMatchObject({ id: positiveIds[0], http_status: null, receipt: null });
    expect(saved.diagnostics.cases[0].request_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.diagnostics.cases[1].receipt).toEqual(degraded);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps receipt capture opt-in for other runner users', async () => {
    fixtures([positiveIds[0]!]);
    respond(receipt('ALLOW'));
    const report = await runSuite({ suitePath, env: env(false) });
    expect(report.gate.exit_code).toBe(0);
    expect(report).not.toHaveProperty('diagnostics');
    expect(existsSync(reportPath)).toBe(false);
  });

  it('dry-run makes no HTTP calls and writes no receipt archive', async () => {
    fixtures();
    await runSuite({ suitePath, env: env(), dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(reportPath)).toBe(false);
  });
});
