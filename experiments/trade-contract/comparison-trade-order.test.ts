import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { dispatchComparison } from './comparison-offline.ts';
import { SCHEMA_SMOKE_SOFT_CAP_NOTE } from './comparison-smoke.ts';
import { buildArmRequest } from './comparison-run.ts';
import { tradeOrderCases } from './dev-v3/cases.ts';

function source(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8');
}

function okResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: '{"not":"adapter"}' } }],
    usage: { cost_in_usd_ticks: 1, prompt_tokens: 1, completion_tokens: 1 },
  }), { status: 200 });
}

describe('trade-order selector', () => {
  it('prints the plan and sends nothing', async () => {
    const fetchImpl = vi.fn();
    const result = await dispatchComparison(['--trade-order-dev'], {}, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const plan = JSON.parse(result.stdout) as {
      selector: string;
      version: string;
      head: string;
      caseIds: string[];
      arms: string[];
      maxCalls: number;
      timeoutMs: number;
      calls: { caseId: string; arm: string; estimateUsd: number }[];
      costCeilingUsd: number;
      costLimit: { usd: number; kind: string; reason: string };
    };
    expect(plan.selector).toBe('trade-order-dev');
    expect(plan.version).toBe('dev-v3');
    expect(plan.head).toMatch(/^[0-9a-f]{40}$/);
    expect(plan.caseIds).toEqual(['v3-01', 'v3-02', 'v3-03', 'v3-04', 'v3-05', 'v3-06']);
    expect(plan.arms).toEqual(['A', 'B']);
    expect(plan.maxCalls).toBe(12);
    expect(plan.timeoutMs).toBe(45_000);
    expect(plan.calls).toHaveLength(12);
    expect(plan.costCeilingUsd).toBeCloseTo(plan.calls.reduce((sum, call) => sum + call.estimateUsd, 0));
    expect(plan.costLimit).toEqual({ usd: 1, kind: 'soft', reason: SCHEMA_SMOKE_SOFT_CAP_NOTE });
  });

  it('sends exactly the twelve built trade-order requests on the paid path', async () => {
    const seen: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body ?? '{}')));
      return okResponse();
    });
    const result = await dispatchComparison(
      ['--trade-order-dev', '--paid'],
      { XAI_API_KEY: 'test-key' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.exitCode).toBe(0);
    expect(seen).toHaveLength(12);
    let index = 0;
    for (const item of tradeOrderCases()) {
      for (const arm of ['A', 'B'] as const) {
        expect(seen[index]).toEqual(buildArmRequest(item.documents, arm));
        index += 1;
      }
    }
    const report = JSON.parse(result.stdout) as {
      calls_sent: number;
      rows: { caseId: string; arm: string; parserResult: string; frozenGateVerdict: string; publicVerdict: string; durationMs: number; expected: string; decisiveReason: string | null }[];
    };
    expect(report.calls_sent).toBe(12);
    expect(report.rows.map(row => `${row.caseId} ${row.arm}`)).toEqual(
      tradeOrderCases().flatMap(item => ['A', 'B'].map(arm => `${item.caseId} ${arm}`)),
    );
    expect(report.rows.every(row => typeof row.durationMs === 'number' && row.parserResult !== 'not_run')).toBe(true);
    expect(report.rows[0].expected).toBe('ALLOW');
    expect(JSON.stringify(seen)).not.toContain('pairId');
    expect(JSON.stringify(seen)).not.toContain('SEALED:');
  });

  it('aborts contradictory selectors before a send and keeps the old commands', async () => {
    for (const args of [
      ['--trade-order-dev', '--schema-smoke'],
      ['--trade-order-dev', '--schema-smoke', '--paid'],
      ['--trade-order-dev', '--pilot'],
      ['--trade-order-dev', '--pilot', '--paid'],
    ]) {
      const fetchImpl = vi.fn();
      const result = await dispatchComparison(args, { XAI_API_KEY: 'test-key' }, fetchImpl as unknown as typeof fetch);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain('No request was sent');
    }
    const planFetch = vi.fn();
    const smoke = await dispatchComparison(['--schema-smoke'], {}, planFetch as unknown as typeof fetch);
    expect(planFetch).not.toHaveBeenCalled();
    expect(JSON.parse(smoke.stdout).caseIds).toEqual(['dev-01', 'dev-02', 'dev-03', 'dev-04', 'dev-05', 'dev-06']);
    const pilotFetch = vi.fn();
    const pilot = await dispatchComparison(['--paid'], { XAI_API_KEY: 'test-key' }, pilotFetch as unknown as typeof fetch);
    expect(pilotFetch).not.toHaveBeenCalled();
    expect(pilot.stderr).toContain('Paid pilot refused');
    const paidSmoke: string[] = [];
    const smokeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      paidSmoke.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 400 });
    });
    await dispatchComparison(['--schema-smoke', '--paid'], { XAI_API_KEY: 'test-key' }, smokeFetch as unknown as typeof fetch);
    expect(paidSmoke).toHaveLength(12);
    expect(paidSmoke.join('\n')).not.toContain('Sell 10 of the 40 Helio shares');
    expect(paidSmoke.join('\n')).not.toContain('pilot-01');
  });

  it('does not retry a timeout and does not load sealed labels while building requests', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      }
      return okResponse();
    });
    const result = await dispatchComparison(
      ['--trade-order-dev', '--paid'],
      { XAI_API_KEY: 'test-key' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(calls).toBe(12);
    const report = JSON.parse(result.stdout) as { calls_sent: number; rows: { caseId: string; arm: string; providerStatus: string }[] };
    expect(report.calls_sent).toBe(12);
    expect(report.rows[0]).toMatchObject({ caseId: 'v3-01', arm: 'A', providerStatus: 'timeout' });
    expect(report.rows.filter(row => row.caseId === 'v3-01' && row.arm === 'A')).toHaveLength(1);
    expect(source('./comparison-plan.ts')).not.toContain('dev-v2/labels');
    expect(source('./comparison-run.ts')).not.toContain('dev-v2/labels');
    expect(source('./comparison-trade-order.ts')).not.toContain("from './dev-v2/labels.ts'");
    expect(source('./comparison-trade-order.ts')).toContain("import('./dev-v3/labels.ts')");
  });
});
