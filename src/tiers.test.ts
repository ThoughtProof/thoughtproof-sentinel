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

  it('standard is Nano→Pro at $0.008 and is default', () => {
    const std = getTierConfig('standard');
    expect(std.price_usd).toBe(0.008);
    expect(std.cascade).toEqual(['serv-nano', 'serv-pro']);
    expect(std.default).toBe(true);
    expect(std.false_allows).toBe(0);
  });

  it('getTierConfig defaults to standard', () => {
    expect(getTierConfig().tier).toBe('standard');
    expect(getTierConfig(undefined).tier).toBe('standard');
    expect(getTierConfig('checkpoint').tier).toBe('checkpoint');
  });
});
