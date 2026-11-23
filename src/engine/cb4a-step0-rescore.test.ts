import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { applyPlainMarketStep0, isPlainMarketOrder } from './trade-execution-step0.js';
import {
  TRADE_GOLD,
  loadJson,
  rescoreNov23,
  rescorePaid,
  type Nov23Fixture,
  type PaidFixture,
} from './cb4a-offline-rescore.js';

const fixtureDir = join(process.cwd(), 'test', 'fixtures', 'cb4a-rescore');

describe('reworked step_0 offline re-score', () => {
  it('re-scores the paid sample and the Nov 23 replay for plain market orders', async () => {
    const paid = loadJson<PaidFixture>(join(fixtureDir, 'paid.json'));
    const nov = loadJson<Nov23Fixture>(join(fixtureDir, 'nov23.json'));
    for (const cse of Object.values(paid.cases)) expect(isPlainMarketOrder(cse.claim)).toBe(true);
    for (const claim of Object.values(nov.claims)) expect(isPlainMarketOrder(claim.claim)).toBe(true);
    const step0 = (result: Parameters<typeof applyPlainMarketStep0>[0], claim: string, evidence: string) =>
      applyPlainMarketStep0(result, claim, evidence, TRADE_GOLD);
    const paidReport = await rescorePaid(paid, step0);
    const novReport = rescoreNov23(nov, step0);
    expect(paidReport.columns.fix1_plus_fix3.distribution).toEqual({ ALLOW: 36, UNCERTAIN: 17, ERROR: 3, BLOCK: 4 });
    expect(paidReport.columns.fix1_plus_fix3.block_BLOCKSET).toBe('4/30');
    expect(paidReport.columns.fix1_plus_fix3.block_CONTROL).toBe('0/30');
    expect(paidReport.columns.fix1_plus_fix3.block_loser).toBe('4/30');
    expect(paidReport.columns.fix1_plus_fix3.block_winner).toBe('0/30');
    expect(paidReport.columns.fix1_plus_fix3_swift_fallback.distribution).toEqual({ ALLOW: 36, UNCERTAIN: 20, BLOCK: 4 });
    expect(paidReport.grok.fix1_plus_fix3.distribution).toEqual({ ALLOW: 50, BLOCK: 3, UNCERTAIN: 7 });
    expect(paidReport.grok.fix1_plus_fix3.block_loser).toBe('3/30');
    expect(paidReport.grok.fix1_plus_fix3.block_winner).toBe('0/30');
    expect(novReport.fix3?.distribution).toEqual({ UNCERTAIN: 756, BLOCK: 219, ALLOW: 21 });
    expect(novReport.fix3?.block_BLOCKSET).toBe('167/498');
    expect(novReport.fix3?.block_CONTROL).toBe('52/498');
    if (process.env.CB4A_RESCORE_PRINT === '1') {
      console.log(JSON.stringify({
        fix1_plus_fix3: paidReport.columns.fix1_plus_fix3,
        fix1_plus_fix3_swift_fallback: paidReport.columns.fix1_plus_fix3_swift_fallback,
        grok_fix3: paidReport.grok.fix1_plus_fix3,
        nov23_fix3: novReport.fix3,
      }, null, 2));
    }
  });
});
