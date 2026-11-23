/**
 * step_model follows the result whose steps are on the receipt, not the last
 * model that was called. Offline fetch only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verify } from './index.js';
import {
  resetTradeExecutionQualityForTests,
  tradeExecutionCascadeErrorCount,
  tradeExecutionQualityShares,
} from './trade-execution-quality.js';

const EVIDENCE = 'alpha evidence span shows the shelf and the direction.';

function chat(content: string, status = 200): Response {
  return new Response(JSON.stringify({
    model: 'stub',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }), { status, headers: { 'content-type': 'application/json' } });
}

function nanoAllow(): string {
  const quote = 'alpha evidence span';
  return JSON.stringify([0, 1, 2].map((i) => ({
    step_id: `step_${i}`,
    score: 1,
    reasoning: `step ${i} is supported by the trace`,
    quote,
  })));
}

function qualityLogs(): Array<{ step_model: string | null; cascade_error?: boolean; steps: number }> {
  return vi.mocked(console.log).mock.calls
    .map((call) => {
      try {
        return JSON.parse(String(call[0])) as { event?: string; step_model: string | null; cascade_error?: boolean; steps: number };
      } catch {
        return null;
      }
    })
    .filter((row): row is { event?: string; step_model: string | null; cascade_error?: boolean; steps: number } =>
      row?.event === 'sentinel.trade_execution.step_quality');
}

describe('step_model follows the receipt steps', () => {
  let nanoStatus: number;
  let nanoBody: string;
  let swiftStatus: number;
  let swiftBody: string;

  beforeEach(() => {
    resetTradeExecutionQualityForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('SERV_API_KEY', 'offline-test-not-a-secret');
    vi.stubEnv('CONFIRM_BLOCKS', '');
    nanoStatus = 200;
    nanoBody = nanoAllow();
    swiftStatus = 200;
    swiftBody = nanoAllow();
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      if (body.model === 'serv-nano') return chat(nanoBody, nanoStatus);
      return chat(swiftBody, swiftStatus);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTradeExecutionQualityForTests();
  });

  it('keeps step_model on serv-nano when nano succeeds and swift fails', async () => {
    swiftStatus = 500;
    const res = await verify({
      claim: 'BUY market order: 75 USDC of XRP-USDC on Coinbase',
      evidence: EVIDENCE,
      mode: 'trade_execution',
      tier: 'standard',
    });
    expect(res.objections.length).toBeGreaterThan(0);
    expect(res.meta.models_used).toContain('serv-swift');
    const logged = qualityLogs().at(-1);
    expect(logged?.step_model).toBe('serv-nano');
    expect(logged?.cascade_error).toBeUndefined();
    expect(tradeExecutionQualityShares('serv-nano').steps).toBeGreaterThan(0);
    expect(tradeExecutionQualityShares('serv-swift').steps).toBe(0);
  });

  it('uses step_model serv-swift when nano is malformed and swift succeeds', async () => {
    nanoBody = JSON.stringify([{ step_id: 'step_0', score: 0, reason: 'only one step' }]);
    const res = await verify({
      claim: 'BUY market order: 75 USDC of XRP-USDC on Coinbase',
      evidence: EVIDENCE,
      mode: 'trade_execution',
      tier: 'standard',
    });
    expect(res.meta.models_used).toEqual(['serv-nano', 'serv-swift']);
    const logged = qualityLogs().at(-1);
    expect(logged?.step_model).toBe('serv-swift');
    expect(tradeExecutionQualityShares('serv-swift').steps).toBeGreaterThan(0);
    expect(tradeExecutionQualityShares('serv-nano').steps).toBe(0);
  });

  it('attributes no steps when both models fail, and counts the error separately', async () => {
    nanoStatus = 500;
    swiftStatus = 500;
    await expect(verify({
      claim: 'BUY market order: 75 USDC of XRP-USDC on Coinbase',
      evidence: EVIDENCE,
      mode: 'trade_execution',
      tier: 'standard',
    })).rejects.toThrow(/both primary and secondary failed/);
    expect(tradeExecutionCascadeErrorCount()).toBe(1);
    expect(tradeExecutionQualityShares('serv-nano').steps).toBe(0);
    expect(tradeExecutionQualityShares('serv-swift').steps).toBe(0);
    const logged = qualityLogs().at(-1);
    expect(logged?.cascade_error).toBe(true);
    expect(logged?.step_model).toBeNull();
    expect(logged?.steps).toBe(0);
  });
});
