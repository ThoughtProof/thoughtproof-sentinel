import { describe, expect, it } from 'vitest';
import { listTiers, getTierConfig, TIER_CONFIGS, resolveCascadeModels, SERV_TO_POTCLI } from './tiers.js';

describe('Sentinel tiers', () => {
  it('has exactly 2 tiers', () => {
    expect(listTiers()).toHaveLength(2);
  });

  it('checkpoint is Nano solo at $0.003', () => {
    const cp = TIER_CONFIGS.checkpoint;
    expect(cp.price_usd).toBe(0.003);
    expect(cp.cascade).toEqual(['nano']);
    expect(cp.false_allows).toBe(0);
  });

  it('standard is Nano→Pro at $0.005 and is default', () => {
    const std = TIER_CONFIGS.standard;
    expect(std.price_usd).toBe(0.005);
    expect(std.cascade).toEqual(['nano', 'pro']);
    expect(std.default).toBe(true);
    expect(std.false_allows).toBe(0);
  });

  it('getTierConfig defaults to standard', () => {
    expect(getTierConfig().tier).toBe('standard');
    expect(getTierConfig(undefined).tier).toBe('standard');
    expect(getTierConfig('checkpoint').tier).toBe('checkpoint');
  });
});

describe('SERV → pot-cli model resolution', () => {
  it('maps nano → gemini, pro → sonnet', () => {
    expect(SERV_TO_POTCLI.nano).toBe('gemini');
    expect(SERV_TO_POTCLI.pro).toBe('sonnet');
  });

  it('resolveCascadeModels translates SERV labels', () => {
    expect(resolveCascadeModels(['nano'])).toEqual(['gemini']);
    expect(resolveCascadeModels(['nano', 'pro'])).toEqual(['gemini', 'sonnet']);
  });

  it('passes through unknown model names unchanged', () => {
    expect(resolveCascadeModels(['gemini', 'sonnet'])).toEqual(['gemini', 'sonnet']);
    expect(resolveCascadeModels(['opus'])).toEqual(['opus']);
  });
});
