import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SentinelVerifyResponse, SentinelVerifyRequest } from './types.js';
import { generateKeyPairSync } from 'node:crypto';

// Mock providers and external side effects only: real handler, engine, classification,
// evidence post-processing and receipt serialization run offline.
vi.mock('pot-cli/plv', () => ({ evaluateItem: vi.fn() }));
vi.mock('pot-cli/cascade', () => ({ runCascade: vi.fn() }));
vi.mock('./billing.js', () => ({
  buildBillingEvent: vi.fn(() => ({ price_usd: 0.005, platform: 'direct' })),
  recordBillingEvent: vi.fn(async () => undefined),
}));
vi.mock('./auth.js', () => ({
  validateApiKey: () => ({ valid: true }),
  checkGlobalRateLimit: async () => ({ allowed: true, remaining: 99 }),
  checkRateLimit: async () => ({ allowed: true, remaining: 99 }),
  rateLimitUnavailablePayload: () => ({}),
  AUTHENTICATED_RATE_LIMIT_PER_MINUTE: 100,
  RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_S: 60,
}));
vi.mock('./middleware/x402.js', () => ({ x402Gate: async () => ({ allowed: true }) }));
vi.mock('./model-config.js', () => ({
  isModelConfigReady: () => true, isModelConfigError: () => false,
  modelConfigUnavailablePayload: () => ({}),
}));
vi.mock('./adr0020/shadow.js', () => ({ runShadowObservability: vi.fn() }));

import handler from '../api/sentinel/verify.js';
import { runCascade } from 'pot-cli/cascade';
import { verify } from './engine/index.js';
import { classifyActionAuthKind } from './engine/action-auth-kind.js';
import { issueSignedCanonicalExport } from './canonical-export.js';
import { MCP_EVIDENCE_ACTION_LABEL, MCP_EVIDENCE_MANDATE_LABEL } from './step-quote-provenance.js';

const DOC_EXAMPLE = 'FYI an CoS: Agenda fuer morgen posten.';
function request(mandate: string, action: string): SentinelVerifyRequest {
  return {
    claim: 'The proposed action is authorized by the mandate.',
    evidence: `${MCP_EVIDENCE_MANDATE_LABEL}\n${mandate}\n\n${MCP_EVIDENCE_ACTION_LABEL}\n${action}`,
    mode: 'action_authorization', tier: 'standard',
    mandate: { kind: 'informational', action: { kind: 'informational' } },
  };
}

beforeEach(() => {
  vi.stubEnv('SENTINEL_EXPORT_PRIVATE_KEY', '');
  vi.stubEnv('ATTESTER_PRIVATE_KEY', '');
  const item = {
    id: 'offline-85', verdict: 'ALLOW' as const, verdict_reasoning: 'fixture all-pass',
    step_evaluations: ['c1', 'c2', 'c3', 'c4'].map(step_id => ({
      step_id, predicate: 'supported' as const, score: 1, quote: null, reasoning: 'fixture',
      tier: 'strong' as const,
      quote_location: { turn: null, line_start: null, line_end: null, char_offset_start: null, char_offset_end: null },
      quote_to_criterion_mapping: null, abstain_if_uncertain: false,
    })), provenance_violations: [], overall_score: 1,
  };
  vi.mocked(runCascade).mockResolvedValue({
    verdict: 'ALLOW', reason: 'agreement_allow', primary: item, secondary: item,
    primaryModel: 'offline-primary', secondaryModel: 'offline-secondary',
    secondaryInvoked: true, degradedMode: false, errors: [], totalLatencyMs: 1,
  } as Awaited<ReturnType<typeof runCascade>>);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('issue #85 real engine and API receipts (offline cascade)', () => {
  it('logs and serializes declared/prose/effective kinds on the BLOCK path without full text', async () => {
    const privateText = 'Agenda fuer internes Team PRIVATE_PAYLOAD_CANARY';
    const body = request(privateText, privateText);
    let result: SentinelVerifyResponse | undefined;
    let status = 0;
    const res = {
      setHeader() { return res; },
      status(n: number) { status = n; return res; },
      json(value: SentinelVerifyResponse) { result = value; return res; },
      end() { return res; },
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body } as never, res as never);
    expect(status).toBe(200);
    expect(result?.verdict).toBe('BLOCK');
    expect(result?.meta.promotion).toMatchObject({
      action_kind: 'informational', mandate_kind: 'informational',
      prose_action_kind: 'unknown', prose_mandate_kind: 'unknown',
      caller_kinds_diagnostic: {
        caller_action_kind: 'informational', caller_mandate_kind: 'informational',
        caller_kinds_do_not_widen: false, triggering_rule: 'callerDeclaredKindsDoNotWiden',
      },
    });
    const lines = log.mock.calls.map(c => String(c[0])).join('\n');
    for (const field of ['verdict=BLOCK', 'prose_action_kind=unknown', 'prose_mandate_kind=unknown',
      'caller_action_kind=informational', 'caller_mandate_kind=informational',
      'caller_kinds_do_not_widen=0', 'triggering_rule=callerDeclaredKindsDoNotWiden']) {
      expect(lines).toContain(field);
    }
    expect(lines).not.toContain('PRIVATE_PAYLOAD_CANARY');
    expect(JSON.stringify(result?.meta.promotion)).not.toContain('PRIVATE_PAYLOAD_CANARY');
  });

  it('exact documented FYI example fits kinds; no universal ALLOW promise', async () => {
    const body = request(DOC_EXAMPLE, DOC_EXAMPLE);
    const result = await verify(body);
    expect(result.meta.promotion).toMatchObject({
      prose_action_kind: 'informational', prose_mandate_kind: 'informational',
      caller_kinds_diagnostic: { caller_kinds_do_not_widen: true },
    });
    expect(result.meta.promotion?.caller_kinds_diagnostic?.triggering_rule).toBeUndefined();
    expect(result.verdict).toBe('ALLOW'); // only under this fixture's all-pass cascade
  });

  it.each([
    'FYI: Send $100 to wallet 0x123',
    'FYI: Transfer 5 ETH to 0x123',
    'FYI: Pay 50 USDC to 0x123',
  ])('all-pass cascade cannot bypass mismatch: %s', async action => {
    const result = await verify(request(DOC_EXAMPLE, action));
    expect(result.verdict).toBe('BLOCK');
    expect(result.meta.promotion?.caller_kinds_diagnostic?.triggering_rule).toBe('callerDeclaredKindsDoNotWiden');
  });

  // Existing informational-leading ship ambiguity is characterized separately
  // from money-transfer protection; not a new authorization policy in #85.
  it('characterizes pre-existing FYI ship ambiguity (not a safety acceptance)', async () => {
    const result = await verify(request(DOC_EXAMPLE, 'FYI: Ship PR #85 now'));
    expect(result.verdict).toBe('ALLOW');
  });

  it('names the same rejecting rule for named prose conflicts without unknown kinds', () => {
    const result = classifyActionAuthKind('Send $100 to wallet 0x123', 'Send $100 to wallet 0x123', {
      kind: 'deploy_ship', action: { kind: 'deploy_ship' },
    });
    expect(result.prose_action_kind).toBe('value_transfer');
    expect(result.caller_kinds_diagnostic?.triggering_rule).toBe('callerDeclaredKindsDoNotWiden');
  });

  it('additive diagnostics leave canonical.v1 bytes, digest and signature unchanged', async () => {
    const response = await verify(request(DOC_EXAMPLE, 'Agenda fuer internes Team'));
    const without = structuredClone(response);
    delete without.meta.promotion?.prose_action_kind;
    delete without.meta.promotion?.prose_mandate_kind;
    delete without.meta.promotion?.caller_kinds_diagnostic;
    const { privateKey } = generateKeyPairSync('ed25519');
    const opts = { privateKey, keyId: 'offline-issue-85', nowSeconds: 1000 };
    expect(issueSignedCanonicalExport(response, opts)).toEqual(issueSignedCanonicalExport(without, opts));
  });
});
