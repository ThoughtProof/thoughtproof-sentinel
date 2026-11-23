/**
 * Offline serv-nano contract tests. fetch is stubbed. No OpenServ, xAI, or
 * OpenAI call leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateItem } from 'pot-cli/plv';
import { mapVerdict } from './verdict.js';
import { runSentinelCascade } from './cascade.js';
import { countsAsAllow } from './trade-execution-quality.js';
import type { EvalInput } from 'pot-cli/plv';

const EVIDENCE = 'alpha evidence span shows the uptrend and the cited shelf.';

function tradeInput(): EvalInput {
  return {
    id: 'offline-nano',
    question: 'Verify the trade decision.',
    answer: 'BUY market order: 75 USDC of XRP-USDC on Coinbase',
    trace_steps: EVIDENCE,
    gold_plan_steps: [0, 1, 2].map((index) => ({
      index,
      description: `step ${index}`,
      criticality: 'critical' as const,
      acceptance_criterion: `criterion ${index}`,
    })),
  };
}

function chat(content: string, status = 200): Response {
  return new Response(JSON.stringify({
    model: 'stub',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }), { status, headers: { 'content-type': 'application/json' } });
}

function faithfulSteps(): string {
  const quote = 'alpha evidence span';
  return JSON.stringify([0, 1, 2].map((i) => ({
    step_id: `step_${i}`,
    score: 1,
    predicate: 'faithful',
    reasoning: `step ${i} is supported`,
    quote,
  })));
}

function aliasedSteps(): string {
  return JSON.stringify([
    { step_id: 'step_0', score: 0, verdict: 'fail', reason: 'No numerical threshold is cited.' },
    { step_id: 'step_1', score: 1, verdict: 'pass', reason: 'Direction matches.', quote: 'alpha evidence span' },
    { step_id: 'step_2', score: 1, verdict: 'pass', reason: 'Justification is in the trace.', quote: 'alpha evidence span' },
  ]);
}

describe('serv-nano strict contract (offline fetch)', () => {
  const calls: { model: string; system: string; statusSeen: string }[] = [];
  let nanoBodies: Array<{ status: number; content: string }>;
  let swiftBody: { status: number; content: string };

  beforeEach(() => {
    vi.stubEnv('SERV_API_KEY', 'offline-test-not-a-secret');
    vi.stubEnv('CONFIRM_BLOCKS', '');
    calls.length = 0;
    nanoBodies = [];
    swiftBody = { status: 200, content: faithfulSteps() };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string;
        messages?: Array<{ role: string; content: string }>;
      };
      const model = body.model ?? '';
      const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
      calls.push({ model, system, statusSeen: model });
      if (model === 'serv-nano') {
        const next = nanoBodies[0] ?? { status: 200, content: '[]' };
        // A non-200 is sticky so pot-cli's JSON retries stay on the HTTP error
        // instead of falling through to a later malformed 200.
        if (!next || next.status === 200) nanoBodies.shift();
        return chat(next.content, next.status);
      }
      return chat(swiftBody.content, swiftBody.status);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('aliases reason, recomputes predicate, and does not retry a well-formed step', async () => {
    nanoBodies = [{ status: 200, content: aliasedSteps() }];
    const result = await evaluateItem(tradeInput(), 'serv-nano', {
      mode: 'faithfulness',
      maxTokens: 256,
      nanoStepContract: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain('STRICT OUTPUT CONTRACT');
    const step0 = result.step_evaluations.find((s) => s.step_id === 'step_0');
    const step1 = result.step_evaluations.find((s) => s.step_id === 'step_1');
    expect(step0?.reasoning).toContain('No numerical threshold');
    expect(step0?.predicate).toBe('unfaithful');
    expect(step0?.score).toBe(0);
    expect(step1?.predicate).toBe('faithful');
    expect(step1?.score).toBe(1);
  });

  it('retries once when the first list omits a step, then accepts the complete alias', async () => {
    nanoBodies = [
      { status: 200, content: JSON.stringify([{ step_id: 'step_0', score: 0, reason: 'only one step' }]) },
      { status: 200, content: aliasedSteps() },
    ];
    const result = await evaluateItem(tradeInput(), 'serv-nano', {
      mode: 'faithfulness',
      maxTokens: 256,
      nanoStepContract: true,
    });
    expect(calls.filter((c) => c.model === 'serv-nano')).toHaveLength(2);
    expect(result.step_evaluations).toHaveLength(3);
  });

  it('falls back to swift when the retry is still missing a step, and does not ALLOW', async () => {
    const one = JSON.stringify([{ step_id: 'step_0', score: 0, reason: 'only one step' }]);
    nanoBodies = [
      { status: 200, content: one },
      { status: 200, content: one },
    ];
    const out = await runSentinelCascade({
      evalInput: tradeInput(),
      evalMode: 'faithfulness',
      tier: 'standard',
      nanoStepContract: true,
    });
    expect(out.malformedStepFallback).toBe(true);
    expect(out.cascadeReason).toBe('primary_error_fallback');
    expect(out.result.verdict).toBe('HOLD');
    expect(mapVerdict(out.result.verdict, 'trade_execution')).toBe('UNCERTAIN');
    expect(countsAsAllow(mapVerdict(out.result.verdict, 'trade_execution'))).toBe(false);
  });

  it('retries nano once when the first parse has no score, then accepts the alias', async () => {
    nanoBodies = [
      { status: 200, content: JSON.stringify([{ step_id: 'step_0', verdict: 'fail', reason: 'nope' }]) },
      { status: 200, content: aliasedSteps() },
    ];
    const result = await evaluateItem(tradeInput(), 'serv-nano', {
      mode: 'faithfulness',
      maxTokens: 256,
      nanoStepContract: true,
    });
    expect(calls.filter((c) => c.model === 'serv-nano')).toHaveLength(2);
    expect(calls.every((c) => c.system.includes('STRICT OUTPUT CONTRACT'))).toBe(true);
    expect(result.step_evaluations.find((s) => s.step_id === 'step_0')?.reasoning).toContain('No numerical threshold');
  });

  it('keeps provenance when a high score has reasoning but no quote', async () => {
    nanoBodies = [{
      status: 200,
      content: JSON.stringify([
        { step_id: 'step_0', score: 1, reason: 'Looks faithful but I did not quote.' },
        { step_id: 'step_1', score: 1, reason: 'Looks faithful but I did not quote.' },
        { step_id: 'step_2', score: 1, reason: 'Looks faithful but I did not quote.' },
      ]),
    }];
    const result = await evaluateItem(tradeInput(), 'serv-nano', {
      mode: 'faithfulness',
      maxTokens: 256,
      nanoStepContract: true,
    });
    expect(calls).toHaveLength(1);
    for (const step of result.step_evaluations) {
      expect(step.score).toBeLessThanOrEqual(0.25);
      expect(step.predicate).not.toBe('faithful');
      expect(step.quote).toBeNull();
    }
  });

  it('falls back to serv-swift after a second malformed nano reply and does not ALLOW', async () => {
    const malformed = JSON.stringify([{ step_id: 'step_0', verdict: 'fail' }]);
    nanoBodies = [
      { status: 200, content: malformed },
      { status: 200, content: malformed },
    ];
    const out = await runSentinelCascade({
      evalInput: tradeInput(),
      evalMode: 'faithfulness',
      tier: 'standard',
      nanoStepContract: true,
    });
    expect(out.malformedStepFallback).toBe(true);
    expect(out.cascadeReason).toBe('primary_error_fallback');
    expect(out.modelsUsed).toEqual(['serv-nano', 'serv-swift']);
    expect(out.result.verdict).toBe('HOLD');
    const publicVerdict = mapVerdict(out.result.verdict, 'trade_execution');
    expect(publicVerdict).toBe('UNCERTAIN');
    expect(countsAsAllow(publicVerdict)).toBe(false);
    expect(calls.filter((c) => c.model === 'serv-swift').every((c) => !c.system.includes('STRICT OUTPUT CONTRACT'))).toBe(true);
  });

  it.each([401, 429, 500, 503])('does not ALLOW when nano returns HTTP %s', async (status) => {
    nanoBodies = [{ status, content: 'nope' }];
    const out = await runSentinelCascade({
      evalInput: tradeInput(),
      evalMode: 'faithfulness',
      tier: 'standard',
      nanoStepContract: true,
    });
    const publicVerdict = mapVerdict(out.result.verdict, 'trade_execution');
    expect(publicVerdict).not.toBe('ALLOW');
    expect(countsAsAllow(publicVerdict, status)).toBe(false);
    expect(out.malformedStepFallback).toBe(false);
    expect(out.cascadeReason).toBe('primary_error_fallback');
  });

  it('propagates when nano and swift both error, which is not an ALLOW', async () => {
    nanoBodies = [{ status: 500, content: 'nano down' }];
    swiftBody = { status: 429, content: 'swift down' };
    await expect(runSentinelCascade({
      evalInput: tradeInput(),
      evalMode: 'faithfulness',
      tier: 'standard',
      nanoStepContract: true,
    })).rejects.toThrow(/both primary and secondary failed/);
    expect(countsAsAllow('ERROR', 500)).toBe(false);
    expect(countsAsAllow('ERROR', 429)).toBe(false);
  });
});
