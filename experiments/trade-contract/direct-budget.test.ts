import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OUTPUT_ASSUMPTION_TOKENS, SHARED_BUDGET_USD, createComparisonBudget, dispatchWithinBudget, pairStatus, qualityVerdict,
} from './direct-budget.ts';

const root = new URL('../../', import.meta.url);

function promptFor(estimateUsd: number, outputPerMillion: number): string {
  const outputUsd = OUTPUT_ASSUMPTION_TOKENS * outputPerMillion / 1_000_000;
  const inputUsd = Math.max(0, estimateUsd - outputUsd);
  const tokens = Math.round(inputUsd * 1_000_000 / 2);
  return 'x'.repeat(tokens * 4);
}

describe('shared 1 USD budget', () => {
  it('stops a too-expensive next request before any send', async () => {
    let sends = 0;
    const outcome = await dispatchWithinBudget([{
      caseId: 'c1',
      arm: 'sentinel_primary',
      promptText: promptFor(1.01, 6),
      send: async () => {
        sends += 1;
        return { measuredUsd: 0.01, value: 'ALLOW' };
      },
    }]);
    expect(sends).toBe(0);
    expect(outcome.transportCalls).toBe(0);
    expect(outcome.rows[0].status).toBe('not_run_budget');
    expect(outcome.budget.measured_usd).toBe(0);
    expect(outcome.budget.open_reservations_usd).toBe(0);
    expect(outcome.budget.actual_overrun_usd).toBe(0);
  });

  it('stops both arms after one unexpectedly expensive response', async () => {
    let sends = 0;
    const outcome = await dispatchWithinBudget([
      {
        caseId: 'c1', arm: 'sentinel_primary', promptText: promptFor(0.2, 6),
        send: async () => {
          sends += 1;
          return { measuredUsd: 1.2, value: 'BLOCK' };
        },
      },
      {
        caseId: 'c1', arm: 'historical', promptText: 'short',
        send: async () => {
          sends += 1;
          return { measuredUsd: 0.01, value: 'ALLOW' };
        },
      },
    ]);
    expect(sends).toBe(1);
    expect(outcome.rows.map(row => row.status)).toEqual(['result', 'not_run_budget']);
    expect(outcome.rows[0].value).toBe('BLOCK');
    expect(outcome.budget.measured_usd).toBeCloseTo(1.2, 6);
    expect(outcome.budget.open_reservations_usd).toBe(0);
    expect(outcome.budget.actual_overrun_usd).toBeCloseTo(0.2, 6);
    expect(pairStatus(outcome.rows, 'c1')).toBe('incomplete_budget');
    expect(qualityVerdict('incomplete_budget', 'BLOCK')).toBeNull();
  });

  it('stops before a Sentinel secondary call when the estimate would pass 1 USD', async () => {
    let sends = 0;
    const outcome = await dispatchWithinBudget([
      {
        caseId: 'c1', arm: 'sentinel_primary', promptText: promptFor(0.4, 6),
        send: async () => {
          sends += 1;
          return { measuredUsd: 0.9, value: 'UNCERTAIN' };
        },
      },
      {
        caseId: 'c1', arm: 'sentinel_secondary', promptText: promptFor(0.2, 2.5),
        send: async () => {
          sends += 1;
          return { measuredUsd: 0.2, value: 'BLOCK' };
        },
      },
    ]);
    expect(sends).toBe(1);
    expect(outcome.rows[1].status).toBe('not_run_budget');
    expect(outcome.rows[0].value).toBe('UNCERTAIN');
    expect(outcome.budget.measured_usd).toBeCloseTo(0.9, 6);
    expect(outcome.budget.actual_overrun_usd).toBe(0);
  });

  it('keeps the reservation after timeout and after missing usage', async () => {
    let sends = 0;
    const outcome = await dispatchWithinBudget([
      {
        caseId: 'c1', arm: 'sentinel_primary', promptText: promptFor(0.3, 6),
        send: async () => { sends += 1; return { measuredUsd: null, timeout: true, value: null }; },
      },
      {
        caseId: 'c2', arm: 'historical', promptText: 'usage-missing',
        send: async () => { sends += 1; return { measuredUsd: null, value: null }; },
      },
    ]);
    expect(sends).toBe(2);
    expect(outcome.rows.map(row => row.status)).toEqual(['error', 'error']);
    expect(outcome.budget.measured_usd).toBe(0);
    expect(outcome.budget.open_reservations_usd).toBeGreaterThan(0.3);
    expect(outcome.budget.actual_overrun_usd).toBe(0);
    expect(outcome.budget.closed).toBe(false);
    const held = createComparisonBudget(SHARED_BUDGET_USD);
    const ticket = held.tryReserve(0.7);
    held.keep(ticket!);
    expect(held.snapshot().open_reservations_usd).toBeCloseTo(0.7, 6);
    expect(held.snapshot().measured_usd).toBe(0);
    expect(held.wouldExceed(0.4)).toBe(true);
    expect(held.tryReserve(0.4)).toBeNull();
  });

  it('preserves an earlier pair and leaves the unfinished pair out of quality counts', async () => {
    let sends = 0;
    const outcome = await dispatchWithinBudget([
      { caseId: 'done', arm: 'sentinel_primary', promptText: promptFor(0.05, 6), send: async () => { sends += 1; return { measuredUsd: 0.05, value: 'ALLOW' }; } },
      { caseId: 'done', arm: 'historical', promptText: 'h', send: async () => { sends += 1; return { measuredUsd: 0.05, value: 'ALLOW' }; } },
      { caseId: 'later', arm: 'sentinel_primary', promptText: promptFor(0.05, 6), send: async () => { sends += 1; return { measuredUsd: 0.95, value: 'BLOCK' }; } },
      { caseId: 'later', arm: 'historical', promptText: 'h2', send: async () => { sends += 1; return { measuredUsd: 0.01, value: 'ALLOW' }; } },
    ]);
    expect(sends).toBe(3);
    expect(outcome.rows.filter(row => row.caseId === 'done').every(row => row.status === 'result')).toBe(true);
    expect(pairStatus(outcome.rows, 'done')).toBe('complete');
    expect(qualityVerdict('complete', 'ALLOW')).toBe('ALLOW');
    expect(outcome.rows.find(row => row.caseId === 'later' && row.arm === 'sentinel_primary')?.value).toBe('BLOCK');
    expect(outcome.rows.find(row => row.caseId === 'later' && row.arm === 'historical')?.status).toBe('not_run_budget');
    expect(pairStatus(outcome.rows, 'later')).toBe('incomplete_budget');
    expect(qualityVerdict(pairStatus(outcome.rows, 'later'), 'BLOCK')).toBeNull();
  });

  it('confirms the binding, Sentinel, and holdout request hashes', () => {
    const binding = readFileSync(new URL('experiments/trade-contract/direct-binding-manifest.json', root));
    const sentinel = readFileSync(new URL('experiments/trade-contract/direct-freeze-manifest.json', root));
    const holdout = readFileSync(new URL('experiments/trade-contract/fixtures/direct-preflight/holdout-request-hashes.json', root));
    expect(createHash('sha256').update(binding).digest('hex')).toBe('e01e59a4601e783f37152e791fe7788a7e4afb9682543c88a3b0355b5bf49909');
    expect(createHash('sha256').update(sentinel).digest('hex')).toBe('e591e341b04b1f339e56a34a2a592db91cfc0647b79afc094f4d11b688630f98');
    expect(createHash('sha256').update(holdout).digest('hex')).toBe('7c1ea5174a111a67ad30014950215330daa5d7ad9287e88f1a4b51f73838c0c5');
    const rows = JSON.parse(holdout.toString()) as { rows: { sentinelRequestSha256: string; historicalRequestSha256: string }[] };
    expect(rows.rows.map(row => `${row.sentinelRequestSha256} ${row.historicalRequestSha256}`)).toEqual([
      'f261268e3691d12dce669e8df3fe13ad1490984b02c87275b533dd0c0777400a eddb91a8d371dff096347af622c6f441fcb61a0839cac10478f5f9ea30910809',
      '7b830630b922b56aa606f73d5d0d35d71667ff5990048c4c52c2cbbb50901ac3 54de47a2fed2b2b3c7520519b0c4f136ff9b5e61a815f456233682d4d104b225',
      '0d544ee184574019cc0ee67eb9d8e715370d6fe9d6efb69eac84dc351a8c40c5 52bdc25639b648dc9d119c1da2cb5eeabdd68c2420961994d0436347be5bc32f',
      'b4336cfa3fec66abb13ab71ce8458224130faed5be7fec82a7dfa00a46369c6d ed0afacd29ec6fd3bfb1f3bb9dce4b7d4fd8f3fc50d985e421ced37bc794f71c',
      '107013c91e1b14dd607de5dc44f650d47769cff58d9b56f0e6f25471b33a5108 ec3a46738624dda5dfd9dba0bf8b5ce71db17c899d444b2c88cab795b173a226',
      '68576e1d86bd4e3059c8a3634019d9ca65cf73d116007a2706e3d72946104f08 0b2f27cce81c02d1275f4024b0284b702fb470f879eab634e88c101863eb649c',
    ]);
  });
});
