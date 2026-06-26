import { describe, expect, it } from 'vitest';
import { listTiers, listAllTiers, getTierConfig, TIER_CONFIGS } from './tiers.js';

describe('Sentinel tiers', () => {
  it('publicly lists exactly 2 tiers (checkpoint + standard)', () => {
    const pub = listTiers();
    expect(pub).toHaveLength(2);
    expect(pub.map((t) => t.tier).sort()).toEqual(['checkpoint', 'standard']);
  });

  it('hidden tiers (swift, pro) are routable but not publicly listed', () => {
    const publicTiers = listTiers().map((t) => t.tier);
    expect(publicTiers).not.toContain('swift');
    expect(publicTiers).not.toContain('pro');
    // still present in the full config for internal routing
    expect(TIER_CONFIGS.swift.hidden).toBe(true);
    expect(TIER_CONFIGS.pro.hidden).toBe(true);
    expect(listAllTiers().map((t) => t.tier).sort()).toEqual(['checkpoint', 'pro', 'standard', 'swift']);
  });

  it('checkpoint is Nano solo at $0.005', () => {
    const cp = getTierConfig('checkpoint');
    expect(cp.price_usd).toBe(0.005);
    expect(cp.cascade).toEqual(['serv-nano']);
    expect(cp.false_allows).toBe(0);
  });

  it('standard runs the Nano→Swift cascade at $0.008 and is the default', () => {
    const std = getTierConfig('standard');
    expect(std.price_usd).toBe(0.008);
    expect(std.cascade).toEqual(['serv-nano', 'serv-swift']);
    expect(std.default).toBe(true);
    expect(std.false_allows).toBe(0);
  });

  it('swift is a hidden alias of standard (same cascade)', () => {
    const sw = getTierConfig('swift');
    expect(sw.cascade).toEqual(['serv-nano', 'serv-swift']);
    expect(sw.hidden).toBe(true);
    expect(sw.default).toBe(false);
  });

  it('pro is the hidden legacy Nano→Pro cascade', () => {
    const pro = getTierConfig('pro');
    expect(pro.cascade).toEqual(['serv-nano', 'serv-pro']);
    expect(pro.hidden).toBe(true);
    expect(pro.default).toBe(false);
  });

  it('exactly one public tier is marked default', () => {
    expect(listTiers().filter((t) => t.default)).toHaveLength(1);
  });

  it('getTierConfig defaults to standard', () => {
    expect(getTierConfig().tier).toBe('standard');
    expect(getTierConfig(undefined).tier).toBe('standard');
    expect(getTierConfig('checkpoint').tier).toBe('checkpoint');
  });
});
