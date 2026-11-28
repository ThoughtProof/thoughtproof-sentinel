import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createComparisonBudget } from './direct-budget.ts';
import { orderCaseById } from './dev-v3/cases.ts';
import { runDirectComparison, type DirectTransport } from './direct-run.ts';
import type { HoldoutCase } from './direct-holdout-plan.ts';
import { dummyDocuments } from './direct-preflight-dummy.ts';

const RUN_ARCHIVE = '/cursor/stores/self/replay-inputs-20261128/direct-holdout-120s-20261128.tgz';
const HOLDOUT_ZIP = '/cursor/stores/self/holdout-input-20261127/input.zip';
const PRIMARY_IDS = ['d17a63f4', '2e6b384a', '8c036e51', '365dfe89', 'f4072db3'] as const;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubNetwork(): void {
  globalThis.fetch = () => {
    throw new Error('network disabled');
  };
  expect(process.env.XAI_API_KEY).toBeFalsy();
}

function loadHoldout(): HoldoutCase[] {
  const dir = mkdtempSync(join(tmpdir(), 'holdout-replay-'));
  execFileSync('unzip', ['-qo', HOLDOUT_ZIP, '-d', dir]);
  const parsed = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8')) as { cases?: HoldoutCase[] } | HoldoutCase[];
  rmSync(dir, { recursive: true, force: true });
  return Array.isArray(parsed) ? parsed : parsed.cases ?? [];
}

function loadPrimary(caseId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'run2-'));
  execFileSync('tar', ['-xzf', RUN_ARCHIVE, '-C', dir]);
  const saved = JSON.parse(readFileSync(join(dir, 'archive/raw', `${caseId}-sentinel_primary.json`), 'utf8')) as { content: string };
  rmSync(dir, { recursive: true, force: true });
  return saved.content;
}

describe('frozen primary path', () => {
  it('replays the five run-2 primaries without a secondary call', async () => {
    if (!existsSync(RUN_ARCHIVE) || !existsSync(HOLDOUT_ZIP)) return;
    stubNetwork();
    const cases = loadHoldout().filter(row => (PRIMARY_IDS as readonly string[]).includes(row.caseId));
    const primaries = new Map(cases.map(row => [row.caseId, loadPrimary(row.caseId)]));
    const arms: string[] = [];
    const transport: DirectTransport = {
      send: async (request) => {
        arms.push(request.arm);
        if (request.arm === 'sentinel_secondary') throw new Error('secondary was sent');
        if (request.arm === 'sentinel_primary') {
          return { ok: true, content: primaries.get(request.caseId) ?? '', usageUsd: 0.01 };
        }
        return { ok: true, content: '{"execute":false,"verdict":"BLOCK"}', usageUsd: 0.01 };
      },
    };
    const report = await runDirectComparison({
      cases,
      transport,
      budget: createComparisonBudget(100),
    });
    const sentinel = report.outcomes.filter(row => row.system === 'sentinel');
    expect(sentinel.map(row => `${row.caseId} ${row.verdict}`)).toEqual([
      'd17a63f4 UNCERTAIN',
      '2e6b384a UNCERTAIN',
      '8c036e51 BLOCK',
      '365dfe89 UNCERTAIN',
      'f4072db3 UNCERTAIN',
    ]);
    expect(sentinel.every(row => row.secondary_called === false && row.public_verdict_stage === 'primary')).toBe(true);
    expect(arms.filter(arm => arm === 'sentinel_secondary')).toEqual([]);
    expect(sentinel.every(row => row.stages.some(mark => mark.stage === 'sentinel_primary' && mark.event === 'send')
      && row.stages.some(mark => mark.stage === 'sentinel_primary' && mark.event === 'receipt'))).toBe(true);
  });

  it('lets the archived v3-01 B primary reach ALLOW', async () => {
    stubNetwork();
    const saved = JSON.parse(readFileSync(new URL('./fixtures/orddev-v3-20261127/raw/v3-01-B.json', import.meta.url), 'utf8')) as { content: string };
    const item = orderCaseById('v3-01');
    const transport: DirectTransport = {
      send: async (request) => {
        if (request.arm !== 'sentinel_primary') throw new Error(`unexpected ${request.arm}`);
        return { ok: true, content: saved.content, usageUsd: 0.01 };
      },
    };
    const report = await runDirectComparison({
      cases: [{ caseId: 'v3-01', documents: item.documents, world: {}, action: { kind: 'DRAFT' } }],
      transport,
      budget: createComparisonBudget(100),
    });
    const sentinel = report.outcomes.find(row => row.system === 'sentinel');
    expect(sentinel).toMatchObject({ verdict: 'ALLOW', secondary_called: false, public_verdict_stage: 'primary', executed: true });
  });

  it('still escalates a primary that is missing a required root key', async () => {
    stubNetwork();
    const arms: string[] = [];
    const transport: DirectTransport = {
      send: async (request) => {
        arms.push(request.arm);
        if (request.arm === 'sentinel_primary') return { ok: true, content: '{"version":"trade-contract-adapter/v1","complete":true}', usageUsd: 0.01 };
        if (request.arm === 'sentinel_secondary') return { ok: true, content: '{"verdict":"BLOCK"}', usageUsd: 0.01 };
        return { ok: true, content: '{"execute":false,"verdict":"BLOCK"}', usageUsd: 0.01 };
      },
    };
    const report = await runDirectComparison({
      cases: [{ caseId: 'invalid', documents: dummyDocuments(), world: {}, action: { kind: 'DRAFT' } }],
      transport,
      budget: createComparisonBudget(100),
    });
    const sentinel = report.outcomes.find(row => row.system === 'sentinel');
    expect(arms).toEqual(['sentinel_primary', 'sentinel_secondary']);
    expect(sentinel).toMatchObject({ verdict: 'BLOCK', secondary_called: true, public_verdict_stage: 'secondary' });
  });

  it('counts a secondary that was sent and then timed out', async () => {
    stubNetwork();
    const transport: DirectTransport = {
      send: async (request) => {
        if (request.arm === 'sentinel_primary') return { ok: true, content: '{"complete":true}', usageUsd: 0.01 };
        if (request.arm === 'sentinel_secondary') return { ok: false, reason: 'timeout' };
        return { ok: true, content: '{"execute":false,"verdict":"BLOCK"}', usageUsd: 0.01 };
      },
    };
    const report = await runDirectComparison({
      cases: [{ caseId: 'late', documents: dummyDocuments(), world: {}, action: { kind: 'DRAFT' } }],
      transport,
      budget: createComparisonBudget(100),
    });
    const sentinel = report.outcomes.find(row => row.system === 'sentinel');
    expect(sentinel).toMatchObject({ status: 'timeout', verdict: null, secondary_called: true });
    expect(sentinel?.stages.some(mark => mark.stage === 'sentinel_secondary' && mark.event === 'send')).toBe(true);
    expect(sentinel?.stages.some(mark => mark.stage === 'sentinel_secondary' && mark.event === 'timeout')).toBe(true);
  });
});
