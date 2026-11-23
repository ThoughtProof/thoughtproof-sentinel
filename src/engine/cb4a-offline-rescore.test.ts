import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { countsAsAllow } from './trade-execution-quality.js';
import {
  loadJson,
  rescoreNov23,
  rescorePaid,
  type Nov23Fixture,
  type PaidFixture,
  type RateBlock,
} from './cb4a-offline-rescore.js';

const fixtureDir = join(process.cwd(), 'test', 'fixtures', 'cb4a-rescore');

function blocks(block: RateBlock): number {
  return block.distribution.BLOCK ?? 0;
}

describe('offline CB4A re-score', () => {
  it('replays recorded outputs and keeps errors off ALLOW', async () => {
    const paid = loadJson<PaidFixture>(join(fixtureDir, 'paid.json'));
    const nov = loadJson<Nov23Fixture>(join(fixtureDir, 'nov23.json'));
    const paidReport = await rescorePaid(paid);
    const novReport = rescoreNov23(nov);

    expect(paidReport.sanity.nano_current_matches_recorded).toBe('59/59');
    expect(paidReport.sanity.swift_matches_recorded).toBe('59/59');
    expect(paidReport.sanity.grok_current_matches_recorded).toBe('60/60');
    expect(paidReport.sanity.grok_fix1_equals_current).toBe('60/60');

    for (const block of [...Object.values(paidReport.columns), ...Object.values(paidReport.grok), novReport.current]) {
      expect(block.distribution.ALLOW ?? 0).toBe(block.counted_as_allow);
      expect(countsAsAllow('UNCERTAIN')).toBe(false);
      expect(countsAsAllow('ERROR')).toBe(false);
    }

    expect(paidReport.columns.current_main.distribution).toEqual({ BLOCK: 59, UNCERTAIN: 1 });
    expect(paidReport.columns.fix1_strict_recorded.distribution).toEqual({ UNCERTAIN: 45, ERROR: 3, BLOCK: 12 });
    expect(paidReport.columns.fix1_swift_fallback.distribution).toEqual({ UNCERTAIN: 48, BLOCK: 12 });
    expect(paidReport.columns.fix1_swift_fallback.block_BLOCKSET).toBe('8/30');
    expect(paidReport.columns.fix1_swift_fallback.block_CONTROL).toBe('4/30');
    expect(paidReport.columns.fix1_swift_fallback.block_loser).toBe('7/30');
    expect(paidReport.columns.fix1_swift_fallback.block_winner).toBe('5/30');
    expect(paidReport.grok.current_main.distribution).toEqual({ UNCERTAIN: 47, BLOCK: 8, ALLOW: 5 });
    expect(paidReport.grok.fix1.distribution).toEqual(paidReport.grok.current_main.distribution);
    expect(novReport.current.distribution).toEqual({ BLOCK: 975, UNCERTAIN: 21 });
    expect(novReport.replay_matches_recorded_block_or_not).toBe('976/996');
    expect(paidReport.columns.fix1_swift_fallback.counted_as_allow).toBe(0);
    expect(paidReport.columns).not.toHaveProperty('fix1_plus_fix3');
    expect(novReport.not_rescored.length).toBeGreaterThan(0);
    if (process.env.CB4A_RESCORE_PRINT === '1') {
      console.log(JSON.stringify({ paid: paidReport, nov23: novReport }, null, 2));
    }
  });
});
