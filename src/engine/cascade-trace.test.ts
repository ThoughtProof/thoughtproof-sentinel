/**
 * meta.cascade_trace keeps nano's raw steps after swift replaces the receipt
 * and after the plain-order resolver rewrites failing steps. Offline fetch only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCanonicalSentinelVerdict,
  buildCanonicalSentinelVerdictV2,
  serializeCanonicalSentinelVerdict,
} from '../canonical-verdict.js';
import { verify } from './index.js';
import { resetTradeExecutionQualityForTests } from './trade-execution-quality.js';

const CANARY = 'canary-sentinel-key-do-not-leak';
const PLAIN_BUY = 'BUY market order: 75 USDC of XRP-USDC on Coinbase';
const BULLISH = 'Thesis: XRP shows an uptrend and support holds near the shelf.';
const BEARISH = 'Thesis: XRP shows a downtrend and a breakdown under the shelf.';
const NEUTRAL = 'Thesis: the shelf is quiet today.';

function chat(content: string, status = 200): Response {
  return new Response(JSON.stringify({
    model: 'stub',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }), { status, headers: { 'content-type': 'application/json', Authorization: `Bearer ${CANARY}` } });
}

function step(id: number, score: number, reasoning: string, quote: string | null) {
  return { step_id: `step_${id}`, score, reasoning, quote };
}

function body(steps: ReturnType<typeof step>[]): string {
  return JSON.stringify(steps);
}

describe('trade_execution cascade_trace', () => {
  let nanoStatus: number;
  let nanoBody: string;
  let swiftStatus: number;
  let swiftBody: string;

  beforeEach(() => {
    resetTradeExecutionQualityForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('SERV_API_KEY', CANARY);
    vi.stubEnv('CONFIRM_BLOCKS', '');
    nanoStatus = 200;
    swiftStatus = 200;
    nanoBody = '[]';
    swiftBody = '[]';
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      if (parsed.model === 'serv-nano') return chat(nanoBody, nanoStatus);
      return chat(swiftBody, swiftStatus);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTradeExecutionQualityForTests();
  });

  it('keeps nano raw steps when nano BLOCKs and swift does not run', async () => {
    nanoBody = body([
      step(0, 0, 'nano-raw-step-0', null),
      step(1, 0, 'nano-raw-step-1', 'XRP shows a downtrend and a breakdown under the shelf.'),
      step(2, 0, 'nano-raw-step-2', null),
    ]);
    const res = await verify({
      claim: PLAIN_BUY,
      evidence: BEARISH,
      mode: 'trade_execution',
      tier: 'standard',
    });
    const trace = res.meta.cascade_trace;
    expect(res.verdict).toBe('BLOCK');
    expect(trace?.cascade_reason).toBe('primary_block');
    expect(trace?.primary_verdict).toBe('BLOCK');
    expect(trace?.secondary_verdict).toBeNull();
    expect(trace?.steps_source).toBe('serv-nano');
    expect(trace?.secondary_steps).toBeUndefined();
    expect(trace?.primary_steps.map((s) => s.reasoning)).toEqual([
      'nano-raw-step-0',
      'nano-raw-step-1',
      'nano-raw-step-2',
    ]);
    expect(trace?.primary_steps[0]?.predicate).toBe('unfaithful');
    expect(trace?.resolver.applied).toBe(true);
    expect(trace?.resolver.reason).toBe('direction_contradiction');
    expect(trace?.resolver.assessment.direction).toBe('conflict');
    expect(trace?.resolver.rewritten_steps.find((s) => s.step_id === 'step_0')?.predicate).toBe('not_applicable');
    expect(res.objections.find((s) => s.step_id === 'step_0')?.reasoning).not.toContain('nano-raw-step-0');
    expect(() => {
      trace!.primary_steps[0]!.reasoning = 'mutated';
    }).toThrow();
  });

  it('records both models when nano and swift ALLOW', async () => {
    const passing = (who: string) => body([0, 1, 2].map((i) =>
      step(i, 1, `${who}-step-${i}`, 'XRP shows an uptrend')));
    nanoBody = passing('nano');
    swiftBody = passing('swift');
    const res = await verify({
      claim: PLAIN_BUY,
      evidence: BULLISH,
      mode: 'trade_execution',
      tier: 'standard',
    });
    const trace = res.meta.cascade_trace;
    expect(res.verdict).toBe('ALLOW');
    expect(trace?.cascade_reason).toBe('agreement_allow');
    expect(trace?.primary_verdict).toBe('ALLOW');
    expect(trace?.secondary_verdict).toBe('ALLOW');
    expect(trace?.steps_source).toBe('serv-swift');
    expect(trace?.primary_steps[0]?.reasoning).toBe('nano-step-0');
    expect(trace?.secondary_steps?.[0]?.reasoning).toBe('swift-step-0');
    expect(trace?.resolver.applied).toBe(true);
    expect(trace?.resolver.reason).toBe('plain_order_clear');
    expect(res.reasoning).toContain('ALLOW');
  });

  it('keeps the nano HOLD steps when swift BLOCKs and owns the receipt', async () => {
    nanoBody = body([
      step(0, 0, 'nano-hold-only', null),
      step(1, 1, 'nano-pass-1', 'the shelf is quiet'),
      step(2, 1, 'nano-pass-2', 'the shelf is quiet'),
    ]);
    swiftBody = body([
      step(0, 0, 'swift-block-0', null),
      step(1, 0, 'swift-block-1', null),
      step(2, 1, 'swift-pass-2', 'the shelf is quiet'),
    ]);
    const res = await verify({
      claim: 'observe the book',
      evidence: NEUTRAL,
      mode: 'trade_execution',
      tier: 'standard',
    });
    const trace = res.meta.cascade_trace;
    expect(res.verdict).toBe('BLOCK');
    expect(trace?.cascade_reason).toBe('disagreement_hold');
    expect(trace?.primary_verdict).toBe('HOLD');
    expect(trace?.secondary_verdict).toBe('BLOCK');
    expect(trace?.steps_source).toBe('serv-swift');
    expect(trace?.primary_steps[0]?.reasoning).toBe('nano-hold-only');
    expect(trace?.secondary_steps?.[0]?.reasoning).toBe('swift-block-0');
    expect(res.objections[0]?.reasoning).not.toContain('nano-hold-only');
    expect(trace?.resolver.applied).toBe(false);
    expect(trace?.resolver.reason).toBe('not_applicable');
  });

  it('records an empty primary when nano errors and swift is the fallback', async () => {
    nanoStatus = 500;
    nanoBody = 'nope';
    swiftBody = body([
      step(0, 1, 'swift-fallback-0', 'the shelf is quiet'),
      step(1, 1, 'swift-fallback-1', 'the shelf is quiet'),
      step(2, 1, 'swift-fallback-2', 'the shelf is quiet'),
    ]);
    const res = await verify({
      claim: 'observe the book',
      evidence: NEUTRAL,
      mode: 'trade_execution',
      tier: 'standard',
    });
    const trace = res.meta.cascade_trace;
    expect(res.verdict).toBe('UNCERTAIN');
    expect(trace?.cascade_reason).toBe('primary_error_fallback');
    expect(trace?.primary_verdict).toBeNull();
    expect(trace?.primary_steps).toEqual([]);
    expect(trace?.secondary_verdict).toBe('ALLOW');
    expect(trace?.steps_source).toBe('serv-swift');
    expect(trace?.secondary_steps).toHaveLength(3);
    expect(trace?.secondary_steps?.[0]?.reasoning).toBe('swift-fallback-0');
    expect(trace?.resolver.applied).toBe(false);
  });

  it('contains no key, token, or prompt credential', async () => {
    nanoBody = body([0, 1, 2].map((i) => step(i, 0, `plain-reason-${i}`, null)));
    const res = await verify({
      claim: PLAIN_BUY,
      evidence: BEARISH,
      mode: 'trade_execution',
      tier: 'standard',
    });
    const encoded = JSON.stringify(res.meta.cascade_trace);
    expect(encoded).not.toContain(CANARY);
    expect(encoded).not.toMatch(/Bearer |SERV_API_KEY|sk_|api[_-]?key|Authorization/i);
    expect(encoded).not.toContain(PLAIN_BUY);
    expect(encoded).not.toContain('Verify this trade execution');
  });

  it('is absent from the signed canonical body', async () => {
    nanoBody = body([
      step(0, 0, 'nano-raw-step-0', null),
      step(1, 0, 'nano-raw-step-1', 'XRP shows a downtrend and a breakdown under the shelf.'),
      step(2, 0, 'nano-raw-step-2', null),
    ]);
    const res = await verify({
      claim: PLAIN_BUY,
      evidence: BEARISH,
      mode: 'trade_execution',
      tier: 'standard',
    });
    expect(res.verdict).toBe('BLOCK');
    const v1 = serializeCanonicalSentinelVerdict(buildCanonicalSentinelVerdict(res));
    const v2 = serializeCanonicalSentinelVerdict(buildCanonicalSentinelVerdictV2(res, { potCli: '0.8.13' }));
    expect(v1).not.toContain('cascade_trace');
    expect(v1).not.toContain('nano-raw-step-0');
    expect(v2).not.toContain('cascade_trace');
    expect(v2).not.toContain('nano-raw-step-0');
    expect(v1).toContain('"verdict":"BLOCK"');
  });
});
