import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Plain JavaScript runner.
import { loadSuite, runSuite } from '../scripts/action-authorization-suite.mjs';
// @ts-expect-error Plain JavaScript archive projection.
import { redactSuiteReceipt } from '../scripts/lib/action-auth-suite-receipt.mjs';

const CANARY = 'private-canary@example.invalid';
const OPAQUE = 'not-a-recognizable-secret-format';
const ID = 'sent_0123456789abcdef';
const SHA = 'a'.repeat(40);

function response(verdict = 'BLOCK') {
  return {
    id: ID, verdict, confidence: 0.25, mode: 'action_authorization', tier: 'standard',
    reasoning: CANARY,
    objections: [{ step_id: 'step_2', score: 0.25, predicate: 'unsupported',
      criterion: CANARY, quote: CANARY, reasoning: OPAQUE,
      quote_source: 'cascade', quote_match_mode: 'exact', objection_source: 'cascade' }],
    meta: { models_used: ['serv-nano'], promotion: {
      reason: 'already_block', cascade_reason: 'primary_block', decision_basis: 'cascade',
      internal_verdict: 'BLOCK', mapped_verdict: 'BLOCK', public_verdict: 'BLOCK',
      mandate_kind: 'informational', action_kind: 'informational',
      action_kind_source: 'prose', mandate_kind_source: 'caller',
      release_id: SHA, steps_all_pass: false, promoted: false,
      machine_condition_proof_present: false, machine_condition_proof_accepted: false,
      unknown_action: false, unknown_mandate: false, unclassified_abstention: false,
    } },
    signed_export: { canonical: JSON.stringify({ reasoning: CANARY }), digest: '0x' + 'b'.repeat(64) },
  };
}

describe('public artifact privacy boundary', () => {
  it('omits free text, nested promotion payloads and opaque signed bodies without mutating responses', () => {
    const raw = response();
    Object.assign(raw.meta.promotion, { account_email: CANARY, trace: [{ credentials: OPAQUE }] });
    const original = structuredClone(raw);
    const archived = redactSuiteReceipt(raw);
    expect(JSON.stringify(archived)).not.toContain(CANARY);
    expect(JSON.stringify(archived)).not.toContain(OPAQUE);
    expect(archived.receipt).not.toHaveProperty('reasoning');
    expect(archived.receipt.signed_export).not.toHaveProperty('canonical');
    expect(raw).toEqual(original);
    expect(archived.receipt).toMatchObject({
      id: ID, verdict: 'BLOCK', confidence: 0.25,
      objections: [{ step_id: 'step_2', score: 0.25, predicate: 'unsupported',
        quote_source: 'cascade', quote_match_mode: 'exact', objection_source: 'cascade' }],
      meta: { promotion: original.meta.promotion && {
        reason: 'already_block', cascade_reason: 'primary_block', release_id: SHA,
        decision_basis: 'cascade', steps_all_pass: false, machine_condition_proof_accepted: false,
      } },
    });
  });

  it('does not leak secrets placed in unknown field names', () => {
    const archived = redactSuiteReceipt({
      [CANARY]: OPAQUE, meta: { promotion: { [OPAQUE]: CANARY } },
      objections: [{ [CANARY]: true }],
    });
    expect(JSON.stringify(archived)).not.toContain(CANARY);
    expect(JSON.stringify(archived)).not.toContain(OPAQUE);
    expect(archived.dropped_fields).toEqual(expect.arrayContaining(['*', 'meta.promotion.*', 'objections.*']));
  });

  it('rejects secrets in allowed scalar slots, identifiers, models, and identity echoes', () => {
    const raw = { id: CANARY, verdict: CANARY, mode: CANARY, tier: CANARY,
      meta: { models_used: [CANARY], verified_at: CANARY,
        promotion: { reason: CANARY, release_id: CANARY, policy: CANARY, decision_basis: CANARY,
          action_kind: CANARY, steps_all_pass: { value: CANARY } },
        agent_context: { agent_id: CANARY, external_request_id: CANARY, tags: [CANARY] } },
      objections: [{ step_id: CANARY, predicate: CANARY }],
      attestation: { claim_hash: CANARY }, signed_export: { digest: CANARY, keyId: CANARY, signature: CANARY },
      billing: { platform: CANARY, payment_method: CANARY },
    };
    expect(JSON.stringify(redactSuiteReceipt(raw))).not.toContain(CANARY);
  });

  it('retains structured degradation and quote-binding diagnostics', () => {
    const raw = { meta: {
      engine_budget: { reason: 'engine_budget_exhausted', degradedMode: true, stage: 'secondary',
        elapsed_ms: 45000, budget_ms: 45000, reserve_ms: 15000, vercel_max_duration_s: 60,
        known_internal_verdict: 'BLOCK', public_verdict: 'BLOCK', late_result_ignored: true },
      objection_evidence_bind: { surface_gated: true, n_evidence_fail: 1, n_unverified: 0,
        n_verified: 3, codes: ['numeric_exceed_false'], verdict_unchanged: true },
    } };
    expect(redactSuiteReceipt(raw).receipt).toEqual(raw);
  });

  it('locates exact quotes in the public fixture without copying response text or trusting server spans', () => {
    const evidence = 'USER INSTRUCTION: Informiere QA über den Stand.';
    const quote = 'Informiere QA über den Stand.';
    const raw = { objections: [{ step_id: 'step_2', quote, quote_evidence_span: { start: CANARY } },
      { step_id: 'step_1', quote: CANARY }] };
    const result = redactSuiteReceipt(raw, { evidence });
    const span = result.receipt.objections[0].quote_evidence_span;
    expect(evidence.slice(span.start, span.end)).toBe(quote);
    expect(result.receipt.objections[1]).not.toHaveProperty('quote_evidence_span');
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain(quote);
  });

  it('suppresses known credentials even if their format resembles a legitimate release hash', () => {
    const result = redactSuiteReceipt({ meta: { promotion: { release_id: SHA } } }, { secrets: [SHA] });
    expect(JSON.stringify(result)).not.toContain(SHA);
    expect(result.dropped_fields).toContain('meta.promotion.release_id');
  });
});

describe('all public runner outputs (mock HTTP only)', () => {
  let dir: string;
  let reportPath: string;
  let summaryPath: string;
  let suitePath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'suite-privacy-'));
    reportPath = join(dir, 'report.json'); summaryPath = join(dir, 'summary.md'); suitePath = join(dir, 'suite.json');
    fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); vi.stubEnv('GITHUB_STEP_SUMMARY', summaryPath);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  async function run(ids: string[], extraEnv = {}) {
    const suite = loadSuite();
    writeFileSync(suitePath, JSON.stringify({ scenarios: ids.map(id => suite.scenarios.find((s: { id: string }) => s.id === id)) }));
    return runSuite({ suitePath, env: { SENTINEL_NIGHTLY_API_KEY: 'synthetic-key',
      SENTINEL_BASE_URL: 'https://offline.invalid', ACTION_AUTH_SUITE_REPORT_PATH: reportPath, ...extraEnv } });
  }
  function respond(status: number, body: unknown) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  }
  function publicBytes() {
    return readFileSync(reportPath, 'utf8') + readFileSync(summaryPath, 'utf8') +
      JSON.stringify([vi.mocked(console.log).mock.calls, vi.mocked(console.warn).mock.calls, vi.mocked(console.error).mock.calls]);
  }

  it('sanitizes duplicate rows, failure arrays, summaries, logs and non-2xx body fields', async () => {
    respond(200, { ...response(), id: CANARY, meta: { promotion: { reason: CANARY, decision_basis: CANARY, action_kind: CANARY } } });
    for (const status of [401, 429, 429, 503, 503, 500]) {
      respond(status, { error: { message: CANARY }, code: CANARY, id: CANARY,
        verdict: CANARY, meta: { promotion: { reason: CANARY } }, retry_after_ms: 1 });
    }
    const result = await run(['ok-04-fyi-aligned-cos-status', ...Array(4).fill('drain-02-injected-recipient')]);
    expect(result).toMatchObject({ false_ALLOW: 0, false_BLOCK: 1, errors: 4, gate: { exit_code: 1, false_BLOCK_baseline: 0 } });
    expect(publicBytes()).not.toContain(CANARY);
    expect(publicBytes()).not.toContain(OPAQUE);
    const saved = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(saved.diagnostics.cases.slice(1).every((c: { receipt: unknown }) => c.receipt === null)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('keeps a degraded unsafe ALLOW a false_ALLOW and UNCERTAIN a false_BLOCK', async () => {
    const raw = response('ALLOW'); raw.meta.promotion.reason = 'engine_budget_exhausted';
    respond(200, raw); respond(200, response('UNCERTAIN'));
    const result = await run(['drain-02-injected-recipient', 'ok-04-fyi-aligned-cos-status']);
    expect(result).toMatchObject({ false_ALLOW: 1, false_BLOCK: 1, errors: 0,
      gate: { exit_code: 1, false_BLOCK_baseline: 0, fail_reasons: ['false_ALLOW=1', 'false_BLOCK=1>0'] } });
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).rows.map((r: { class: string }) => r.class)).toEqual(['false_ALLOW', 'false_BLOCK']);
    expect(publicBytes()).not.toContain(CANARY);
  });

  it('does not turn an invalid verdict or transport exception into ALLOW or expose exception text', async () => {
    respond(200, { verdict: CANARY });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error(CANARY), { name: CANARY, cause: { code: CANARY } }));
    const result = await run(['drain-02-injected-recipient', 'ok-04-fyi-aligned-cos-status']);
    expect(result).toMatchObject({ false_ALLOW: 0, false_BLOCK: 0, errors: 2, gate: { exit_code: 1 } });
    expect(publicBytes()).not.toContain(CANARY);
  });

  it('omits credentials and private URL components and validates runner metadata without changing the request', async () => {
    const base = `https://user:${OPAQUE}@offline.invalid/${OPAQUE}?token=${OPAQUE}#${OPAQUE}`;
    respond(200, response('ALLOW'));
    const result = await run(['ok-04-fyi-aligned-cos-status'], {
      SENTINEL_BASE_URL: base, SENTINEL_TIER: CANARY, GITHUB_SHA: CANARY, GITHUB_RUN_ID: CANARY,
    });
    expect(result.gate.exit_code).toBe(0);
    expect(fetchMock.mock.calls[0][0]).toBe(`${base}/sentinel/verify`);
    expect(result).toMatchObject({ base: 'https://offline.invalid', tier: null,
      diagnostics: { suite_commit: null, workflow_run_id: null } });
    expect(publicBytes()).not.toContain(CANARY);
    expect(publicBytes()).not.toContain(OPAQUE);
  });
});
