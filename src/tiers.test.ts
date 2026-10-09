import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADVERTISED_LATENCY_MEDIAN,
  listTiers,
  listAllTiers,
  getTierConfig,
  TIER_CONFIGS,
} from './tiers.js';

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

  it('advertises measured prod latency, not a ~1 s median', () => {
    expect(ADVERTISED_LATENCY_MEDIAN).toBe(
      'typically 2–4 s; up to ~16 s on escalation',
    );
    for (const tier of listAllTiers()) {
      expect(tier.latency_median).toBe(ADVERTISED_LATENCY_MEDIAN);
      expect(tier.latency_median).not.toMatch(/0\.9s|1\.2s|1\.3s|~1\s*s/);
    }
  });

  it('README, OpenAPI, and tier ADRs repeat the measured envelope', () => {
    const files = [
      'README.md',
      'api/openapi.ts',
      'docs/ADR-0016-sentinel-api-spec.md',
      'docs/ADR-0020-sentinel-to-rv-escalation.md',
    ];
    for (const rel of files) {
      const text = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(text, rel).toContain(ADVERTISED_LATENCY_MEDIAN);
      expect(text, rel).not.toMatch(/0\.9s|1\.2s|1\.3s|2\.3s/);
    }
  });
});
