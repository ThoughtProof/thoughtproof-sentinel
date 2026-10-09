import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBazaarExtensions } from './middleware/bazaar-extension.js';
import {
  CHECKPOINT_ADVERTISED_LATENCY,
  STANDARD_ADVERTISED_LATENCY,
  PRO_ADVERTISED_LATENCY,
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

  it('advertises checkpoint and standard latency separately', () => {
    expect(CHECKPOINT_ADVERTISED_LATENCY).toBe(
      'Nano-only, no cascade. Nano-path latency not yet measured. Deterministic BLOCK: observed prod range 2–4 s (sample size not recorded). 45 s engine budget → UNCERTAIN (REVIEW); known BLOCK or objective mismatch stays BLOCK',
    );
    expect(STANDARD_ADVERTISED_LATENCY).toContain(
      'observed in prod live suite 8–9 Oct 2026, n=28 standard ALLOWs, 8.2–14.6 s, median 10.6 s',
    );
    expect(getTierConfig('checkpoint').latency_median).toBe(CHECKPOINT_ADVERTISED_LATENCY);
    expect(getTierConfig('standard').latency_median).toBe(STANDARD_ADVERTISED_LATENCY);
    expect(getTierConfig('swift').latency_median).toBe(STANDARD_ADVERTISED_LATENCY);
    expect(getTierConfig('pro').latency_median).toBe(PRO_ADVERTISED_LATENCY);
    expect(CHECKPOINT_ADVERTISED_LATENCY).not.toContain('n=28');
    expect(PRO_ADVERTISED_LATENCY).not.toContain('n=28');
    for (const tier of listAllTiers()) {
      expect(tier.latency_median).not.toMatch(/0\.9s|1\.2s|1\.3s|~1\s*s|~8–15 s/);
    }
  });

  it('README, OpenAPI, and tier ADRs keep checkpoint and standard latency apart', () => {
    const files = [
      'README.md',
      'api/openapi.ts',
      'docs/ADR-0016-sentinel-api-spec.md',
      'docs/ADR-0020-sentinel-to-rv-escalation.md',
    ];
    for (const rel of files) {
      const text = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(text, rel).toContain(CHECKPOINT_ADVERTISED_LATENCY);
      expect(text, rel).toContain(STANDARD_ADVERTISED_LATENCY);
      expect(text, rel).not.toMatch(/0\.9s|1\.2s|1\.3s|2\.3s|up to ~16 s|~8–15 s/);
    }
    for (const rel of ['README.md', 'docs/ADR-0016-sentinel-api-spec.md']) {
      const text = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(text, rel).toContain('Nano→Swift');
      expect(text, rel).not.toContain('Nano→Pro');
    }
  });

  it('bazaar example duration matches the tier it names', () => {
    type Example = {
      tier: string;
      meta: { duration_ms?: number; models_used: string[] };
    };
    const checkpoint = buildBazaarExtensions().bazaar.info.output.example as Example;
    const standard = buildBazaarExtensions({ tierHint: 'standard' }).bazaar.info.output
      .example as Example;
    expect(checkpoint.tier).toBe('checkpoint');
    expect(checkpoint.meta.duration_ms).toBeUndefined();
    expect(checkpoint.meta.models_used).toEqual(['serv-nano']);
    expect(standard.tier).toBe('standard');
    expect(standard.meta.duration_ms).toBe(10600);
    expect(standard.meta.models_used).toEqual(['serv-nano', 'serv-swift']);
  });

  it('README and tier ADRs use the code prices ($0.005 / $0.008)', () => {
    const files = [
      'README.md',
      'docs/ADR-0016-sentinel-api-spec.md',
      'docs/ADR-0017-payment-adapter-layer.md',
      'src/adapters/payment/README.md',
    ];
    for (const rel of files) {
      const text = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(text, rel).toContain('$0.005');
      expect(text, rel).toContain('$0.008');
      expect(text, rel).not.toContain('$0.003');
    }
  });
});
