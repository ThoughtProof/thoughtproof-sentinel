import { describe, expect, it } from 'vitest';
import { listTiers, getTierConfig, TIER_CONFIGS } from './tiers.js';

describe('Sentinel tiers', () => {
  it('has exactly 2 tiers', () => {
    expect(listTiers()).toHaveLength(3);
  });

  it('checkpoint is Nano solo at $0.005', () => {
    const cp = getTierConfig('checkpoint');
    expect(cp.price_usd).toBe(0.005);
    expect(cp.cascade).toEqual(['serv-nano']);
    expect(cp.false_allows).toBe(0);
  });

  it('standard is Nano→Pro at $0.008 and is no longer default', () => {
    const std = getTierConfig('standard');
    expect(std.price_usd).toBe(0.008);
    expect(std.cascade).toEqual(['serv-nano', 'serv-pro']);
    expect(std.default).toBe(false);
    expect(std.false_allows).toBe(0);
  });

  it('swift is Nano→Swift at $0.008 and is the default tier', () => {
    const sw = getTierConfig('swift');
    expect(sw.price_usd).toBe(0.008);
    expect(sw.cascade).toEqual(['serv-nano', 'serv-swift']);
    expect(sw.default).toBe(true);
    expect(sw.false_allows).toBe(0);
  });

  it('exactly one tier is marked default', () => {
    expect(listTiers().filter((t) => t.default)).toHaveLength(1);
  });

  it('getTierConfig defaults to swift', () => {
    expect(getTierConfig().tier).toBe('swift');
    expect(getTierConfig(undefined).tier).toBe('swift');
    expect(getTierConfig('checkpoint').tier).toBe('checkpoint');
  });
});
