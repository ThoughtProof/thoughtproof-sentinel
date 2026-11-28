import { describe, expect, it } from 'vitest';
import { createComparisonBudget, qualityVerdict } from './direct-budget.ts';
import { DUMMY_CASE_ID, DUMMY_GATEWAY_PROBE, dummyDocuments } from './direct-preflight-dummy.ts';
import { DIRECT_MAX_CALLS, DIRECT_RETRIES, DIRECT_SYSTEM_MS, runDirectComparison, type DirectTransport } from './direct-run.ts';
import type { HoldoutCase } from './direct-holdout-plan.ts';

function sample(caseId = DUMMY_CASE_ID): HoldoutCase {
  return {
    caseId,
    documents: dummyDocuments(),
    world: { ...DUMMY_GATEWAY_PROBE.world },
    action: { ...DUMMY_GATEWAY_PROBE.action, evidence_items: DUMMY_GATEWAY_PROBE.action.evidence_items.map(item => ({ ...item })) },
  };
}

function mockTransport(handler: DirectTransport['send']): { transport: DirectTransport; seen: { retries: number; timeoutMs: number; arm: string }[] } {
  const seen: { retries: number; timeoutMs: number; arm: string }[] = [];
  return {
    seen,
    transport: {
      send: async (request) => {
        seen.push({ retries: request.retries, timeoutMs: request.timeoutMs, arm: request.arm });
        return handler(request);
      },
    },
  };
}

describe('direct comparison run entry', () => {
  it('latches the ledger for the rest of the run when the next reservation would pass 1 USD', async () => {
    const budget = createComparisonBudget();
    const seed = budget.tryReserve(0.01);
    budget.commitMeasured(seed!, 0.9);
    const { transport, seen } = mockTransport(async () => ({ ok: true, content: '{}', usageUsd: 0.01 }));
    const report = await runDirectComparison({ cases: [sample('one'), sample('two')], transport, budget });
    expect(seen).toHaveLength(0);
    expect(report.ledger).toBe(budget);
    expect(budget.snapshot().closed).toBe(true);
    expect(budget.tryReserve(0.01)).toBeNull();
    expect(report.outcomes.every(row => row.status === 'not_run_budget')).toBe(true);
    expect(report.pairs.every(row => row.status === 'incomplete_budget')).toBe(true);
    expect(qualityVerdict('incomplete_budget', 'result', 'BLOCK')).toBeNull();
  });

  it('keeps a timely verdict when usage is missing and does not call that a budget gap', async () => {
    const budget = createComparisonBudget();
    const { transport, seen } = mockTransport(async (request) => {
      if (request.arm === 'historical') return { ok: true, content: '{"execute":true,"verdict":"ALLOW"}', usageUsd: null };
      if (request.arm === 'sentinel_primary') return { ok: false, reason: 'http_error' };
      return { ok: true, content: '{"verdict":"BLOCK"}', usageUsd: null };
    });
    const report = await runDirectComparison({ cases: [sample()], transport, budget });
    expect(report.ledger).toBe(budget);
    expect(seen.map(row => row.arm)).toEqual(['sentinel_primary', 'sentinel_secondary', 'historical']);
    expect(seen.every(row => row.retries === DIRECT_RETRIES && row.timeoutMs <= DIRECT_SYSTEM_MS)).toBe(true);
    const historical = report.outcomes.find(row => row.system === 'historical');
    const sentinel = report.outcomes.find(row => row.system === 'sentinel');
    expect(historical).toMatchObject({ status: 'result', verdict: 'ALLOW', executed: true, protocolError: null });
    expect(sentinel).toMatchObject({ status: 'result', verdict: 'BLOCK', secondary_called: true, public_verdict_stage: 'secondary' });
    expect(budget.snapshot().open_reservations_usd).toBeGreaterThan(0);
    expect(budget.snapshot().measured_usd).toBe(0);
    expect(report.pairs[0].status).toBe('complete');
    expect(qualityVerdict('complete', 'result', 'ALLOW')).toBe('ALLOW');
  });

  it('labels a timeout as technical and does not mark the pair incomplete_budget', async () => {
    const budget = createComparisonBudget();
    const { transport } = mockTransport(async (request) => {
      if (request.arm === 'sentinel_primary') return { ok: false, reason: 'timeout' };
      return { ok: true, content: '{"execute":true,"verdict":"BLOCK"}', usageUsd: 0.01 };
    });
    const report = await runDirectComparison({ cases: [sample()], transport, budget });
    const sentinel = report.outcomes.find(row => row.system === 'sentinel');
    const historical = report.outcomes.find(row => row.system === 'historical');
    expect(sentinel).toMatchObject({ status: 'timeout', verdict: null, executed: false });
    expect(historical).toMatchObject({ status: 'result', verdict: 'BLOCK', executed: false });
    expect(report.pairs[0].status).toBe('complete');
    expect(qualityVerdict(report.pairs[0].status, 'timeout', null)).toBeNull();
    expect(budget.snapshot().open_reservations_usd).toBeGreaterThan(0);
  });

  it('uses one ledger for the primary, the conditional secondary, and the historical critic, and never retries', async () => {
    const budget = createComparisonBudget();
    const { transport, seen } = mockTransport(async (request) => {
      if (request.arm === 'sentinel_secondary') return { ok: true, content: '{"verdict":"BLOCK"}', usageUsd: 0.02 };
      if (request.arm === 'historical') return { ok: true, content: '{"execute":false,"verdict":"BLOCK"}', usageUsd: 0.03 };
      return { ok: false, reason: 'empty' };
    });
    const report = await runDirectComparison({ cases: [sample()], transport, budget, maxCalls: DIRECT_MAX_CALLS });
    expect(report.ledger).toBe(budget);
    expect(seen.map(row => row.arm)).toEqual(['sentinel_primary', 'sentinel_secondary', 'historical']);
    expect(seen.every(row => row.retries === 0)).toBe(true);
    expect(report.calls).toBe(3);
    expect(report.calls).toBeLessThanOrEqual(DIRECT_MAX_CALLS);
    expect(budget.snapshot().measured_usd).toBeCloseTo(0.05, 6);
    const cappedTransport = mockTransport(async () => ({ ok: false, reason: 'empty' }));
    const capped = await runDirectComparison({
      cases: [sample('cap-1'), sample('cap-2')],
      transport: cappedTransport.transport,
      budget: createComparisonBudget(100),
      maxCalls: 1,
    });
    expect(capped.calls).toBe(1);
    expect(cappedTransport.seen).toHaveLength(1);
    expect(cappedTransport.seen[0].retries).toBe(0);
  });
});
