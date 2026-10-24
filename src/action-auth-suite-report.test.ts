import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error The existing JavaScript runner has no declaration file.
import { loadSuite, runSuite } from '../scripts/action-authorization-suite.mjs';
// @ts-expect-error The receipt allowlist helper is plain JavaScript.
import { redactSuiteReceipt, SUITE_RECEIPT_ALLOWLIST } from '../scripts/lib/action-auth-suite-receipt.mjs';

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
    respondStatus(200, body);
  }

  function respondStatus(status: number, body: unknown) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
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

  it('strips injected account, tenant, and api-key fields and keeps the allowlist', async () => {
    fixtures([
      'ok-04-fyi-aligned-cos-status',
      'drain-02-injected-recipient',
      'drain-02-injected-recipient',
      'drain-02-injected-recipient',
    ]);
    const leaked = injectedReceipt();
    respond(leaked);
    respondStatus(401, { error: 'UNAUTHORIZED', code: 'UNAUTHORIZED', account_email: 'error-body-account@example.com' });
    respondStatus(429, { error: 'rate_limited', tenant_id: 'error-body-tenant', retry_after_ms: 1 });
    respondStatus(429, { error: 'rate_limited', tenant_id: 'error-body-tenant', retry_after_ms: 1 });
    respondStatus(500, { error: 'internal', api_key_id: 'error-body-key' });

    const report = await runSuite({ suitePath, env: env() });

    expect(report).toMatchObject({
      false_ALLOW: 0,
      false_BLOCK: 1,
      errors: 3,
      gate: { false_BLOCK_baseline: 0, exit_code: 1, fail_reasons: ['errors=3', 'false_BLOCK=1>0'] },
    });
    expect(report.rows.map((row: { class: string }) => row.class)).toEqual([
      'false_BLOCK', 'error', 'error', 'error',
    ]);
    expect(report.rows[0].verdict).toBe('UNCERTAIN');

    const saved = JSON.parse(readFileSync(reportPath, 'utf8'));
    const archived = saved.diagnostics.cases[0];
    expect(archived.http_status).toBe(200);
    expect(archived.request_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(archived.receipt).toEqual(allowlistedProjection());
    expect(archived.receipt.verdict).toBe('UNCERTAIN');
    expect(archived.dropped_fields).toEqual(injectedDroppedFields());
    expect(saved.diagnostics.dropped_fields).toEqual(injectedDroppedFields());
    expect(saved.diagnostics.cases.slice(1)).toEqual([
      { id: 'drain-02-injected-recipient', http_status: 401, request_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), receipt: null },
      { id: 'drain-02-injected-recipient', http_status: 429, request_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), receipt: null },
      { id: 'drain-02-injected-recipient', http_status: 500, request_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), receipt: null },
    ]);

    const bytes = readFileSync(reportPath, 'utf8');
    for (const secret of INJECTED_SECRETS) expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain(env().SENTINEL_NIGHTLY_API_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

const INJECTED_SECRETS = [
  'founder@example.com',
  'ten_live_42',
  'key_live_99',
  'session-should-drop',
  'erc8004-token-should-drop',
  'package-digest-should-drop',
  'evidence-note-should-drop',
  'attester-should-drop',
  'cardholder@example.com',
  'export-private-key-should-drop',
  'internal-prompt-should-drop',
  'gate-secret-should-drop',
  'error-body-account@example.com',
  'error-body-tenant',
  'error-body-key',
  '1782916498',
  'nested-model-key',
];

function injectedDroppedFields() {
  return [
    'account_email',
    'api_key_id',
    'attestation.attester',
    'attestation.prepared',
    'billing.cardholder_email',
    'gate',
    'meta.agent_context.erc8004',
    'meta.agent_context.session_id',
    'meta.engine_budget',
    'meta.models_used.item',
    'meta.package_digest',
    'objections.internal_prompt',
    'objections.quote_source',
    'signed_export.private_key',
    'signed_export.signedAt',
    'tenant_id',
  ].sort();
}

function allowlistedProjection() {
  return {
    id: 'sent_allowlist_1',
    verdict: 'UNCERTAIN',
    confidence: 0.25,
    reasoning: 'Allowlisted reasoning survives.',
    objections: [{
      step: '2',
      step_id: 'step_2',
      criterion: 'criterion text',
      score: 0.25,
      predicate: 'unsupported',
      quote: 'verbatim quote',
      reasoning: 'step reason',
    }],
    mode: 'action_authorization',
    tier: 'standard',
    meta: {
      duration_ms: 1200,
      models_used: ['serv-nano'],
      verified_at: '2026-10-24T00:00:00.000Z',
      promotion: {
        reason: 'steps_not_all_pass',
        cascade_reason: 'primary_block',
        decision_basis: 'cascade',
        mandate_kind: 'informational',
        action_kind: 'informational',
        release_id: 'synthetic-server-commit',
        policy: 'action-auth-v1',
        steps_all_pass: false,
      },
      agent_context: {
        agent_id: 'nightly-suite',
        agent_runtime: 'github-actions',
        external_request_id: 'ext-req-1',
        tags: ['suite', 'synthetic'],
        identity_source: 'operator_declared',
        identity_verified: false,
      },
    },
    attestation: {
      schema_uid: '0xschema',
      claim_hash: '0xclaim',
      evidence_hash: '0xevidence',
    },
    billing: {
      price_usd: 0.008,
      settled: false,
      platform: 'direct',
      payment_method: 'x402-facilitator',
    },
    signed_export: {
      digest: '0xdigest',
      keyId: 'tp-sentinel-export-ed25519-2026-09',
      alg: 'Ed25519',
      signature: '0xsig',
      canonical: '{"verdict":"UNCERTAIN"}',
    },
  };
}

function injectedReceipt() {
  const keep = allowlistedProjection();
  return {
    ...keep,
    account_email: 'founder@example.com',
    tenant_id: 'ten_live_42',
    api_key_id: 'key_live_99',
    gate: { mode: 'shadow', secret: 'gate-secret-should-drop' },
    objections: [{
      ...keep.objections[0],
      quote_source: 'cascade',
      internal_prompt: 'internal-prompt-should-drop',
    }],
    meta: {
      ...keep.meta,
      models_used: ['serv-nano', { api_key_id: 'nested-model-key' }],
      package_digest: 'package-digest-should-drop',
      engine_budget: { reason: 'not_a_degraded_marker', note: 'evidence-note-should-drop' },
      agent_context: {
        ...keep.meta.agent_context,
        session_id: 'session-should-drop',
        erc8004: { chainId: 8453, tokenId: 'erc8004-token-should-drop' },
      },
    },
    attestation: {
      ...keep.attestation,
      prepared: true,
      attester: 'attester-should-drop',
    },
    billing: {
      ...keep.billing,
      cardholder_email: 'cardholder@example.com',
    },
    signed_export: {
      ...keep.signed_export,
      signedAt: 1782916498,
      private_key: 'export-private-key-should-drop',
    },
  };
}

describe('receipt allowlist', () => {
  it('names the public fields and no caller, account, or tenant key', () => {
    expect(SUITE_RECEIPT_ALLOWLIST).toEqual({
      receipt: ['id', 'verdict', 'confidence', 'reasoning', 'objections', 'mode', 'tier', 'meta', 'attestation', 'billing', 'signed_export'],
      objections: ['step', 'step_id', 'criterion', 'score', 'predicate', 'quote', 'reasoning'],
      meta: ['duration_ms', 'models_used', 'verified_at', 'promotion', 'agent_context'],
      promotion: '*',
      agent_context: ['agent_id', 'agent_runtime', 'external_request_id', 'tags', 'identity_source', 'identity_verified'],
      attestation: ['schema_uid', 'claim_hash', 'evidence_hash'],
      billing: ['price_usd', 'settled', 'platform', 'payment_method'],
      signed_export: ['digest', 'keyId', 'alg', 'signature', 'canonical'],
    });
    const flat = JSON.stringify(SUITE_RECEIPT_ALLOWLIST);
    expect(flat).not.toContain('account_email');
    expect(flat).not.toContain('tenant_id');
    expect(flat).not.toContain('api_key_id');
  });

  it('strips injected identity fields, keeps allowlisted fields, and does not mutate the input', () => {
    const receipt = injectedReceipt();
    const original = structuredClone(receipt);
    const redacted = redactSuiteReceipt(receipt);
    expect(receipt).toEqual(original);
    expect(redacted.receipt).toEqual(allowlistedProjection());
    expect(redacted.dropped_fields).toEqual(injectedDroppedFields());
    const bytes = JSON.stringify(redacted);
    for (const secret of INJECTED_SECRETS) {
      if (secret.startsWith('error-body-')) continue;
      expect(bytes).not.toContain(secret);
    }
    expect(redacted.receipt.verdict).toBe('UNCERTAIN');
  });

  it('keeps a null quote and drops an object stuffed into an allowlisted scalar', () => {
    const stuffed = redactSuiteReceipt({
      id: { account_email: 'stuffed@example.com' },
      verdict: 'UNCERTAIN',
      objections: [{ step_id: 'step_0', quote: null, score: 0, predicate: 'unsupported', criterion: 'c', reasoning: 'r' }],
    });
    expect(stuffed.receipt).toEqual({
      verdict: 'UNCERTAIN',
      objections: [{ step_id: 'step_0', quote: null, score: 0, predicate: 'unsupported', criterion: 'c', reasoning: 'r' }],
    });
    expect(stuffed.dropped_fields).toEqual(['id']);
    expect(JSON.stringify(stuffed)).not.toContain('stuffed@example.com');
  });

  it('archives nothing from a non-object body', () => {
    expect(redactSuiteReceipt(null)).toEqual({ receipt: null, dropped_fields: [] });
    expect(redactSuiteReceipt(['founder@example.com'])).toEqual({
      receipt: null,
      dropped_fields: ['(non-object)'],
    });
    expect(JSON.stringify(redactSuiteReceipt({ account_email: 'founder@example.com' }))).not.toContain('founder@example.com');
  });

  it('keeps promotion JSON fields and drops a non-JSON promotion value by name', () => {
    const trace = () => 'function-secret-should-drop';
    const redacted = redactSuiteReceipt({
      verdict: 'BLOCK',
      meta: { promotion: { reason: 'already_block', steps_all_pass: false, trace } },
    });
    expect(redacted.receipt).toEqual({
      verdict: 'BLOCK',
      meta: { promotion: { reason: 'already_block', steps_all_pass: false } },
    });
    expect(redacted.dropped_fields).toEqual(['meta.promotion.trace']);
    expect(JSON.stringify(redacted)).not.toContain('function-secret-should-drop');
  });
});
