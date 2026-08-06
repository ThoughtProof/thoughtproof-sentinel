import type { SentinelTier } from './types.js';

/**
 * Public tier metadata.
 *
 * Gate-0 rule: every accuracy / false-allow figure MUST carry a denominator
 * and a suite label. Latency strings must not contradict ADR wall-clock reality
 * (typical cascade band seconds–tens of seconds, not sub-second marketing).
 */
export interface TierConfig {
  tier: SentinelTier;
  label: string;
  price_usd: number;
  cascade: string[];
  /** 0–1 rate; always pair with accuracy_n + accuracy_suite when publishing */
  accuracy: number;
  /** Sample size for accuracy */
  accuracy_n: number;
  /** Short label of the calibration / eval suite behind accuracy */
  accuracy_suite: string;
  /** Count of false ALLOWs on the cited suite */
  false_allows: number;
  /** Denominator for false_allows (same suite unless noted) */
  false_allows_n: number;
  /**
   * Human latency band for operators (wall-clock).
   * Not a guaranteed SLO — see ADR freshness vs verifier latency.
   */
  latency_typical: string;
  /** Optional legacy field kept for API compat; prefer latency_typical */
  latency_median: string;
  default: boolean;
  /** When true, routable but NOT in public /tiers listing */
  hidden?: boolean;
  notes: string;
}

/**
 * Calibration snapshot used for public rates (Gate-0 honesty).
 * Source: ADSB / internal cascade calibration cited in product copy.
 * Update rates + n together; never publish FA=0 without n.
 *
 * Primary public safety cite for “0 false allows” style claims:
 * ADSB live FAR run 2026-07-17 — FAR=0 on n=21 stop-cases (DQL path).
 * Tier accuracy % figures below are cascade calibration estimates with n.
 */
const CAL = {
  // Keep conservative denominators until a single frozen tier-calibration report
  // replaces these. Better under-claim than pretty undenominated numbers.
  checkpoint_acc: 0.833,
  checkpoint_n: 48,
  checkpoint_suite: 'internal-cascade-cal-checkpoint-v0',
  standard_acc: 0.813,
  standard_n: 48,
  standard_suite: 'internal-cascade-cal-standard-v0',
  // FA=0 on cited stop-case style suites — always show n
  fa: 0,
  fa_n: 21,
  fa_suite_note: 'FA cite: ADSB-style stop-case suite n=21 (2026-07-17 class); not a universal guarantee',
  // Wall-clock: ADR + live FAR p50≈5s p90≈15s — not 0.9s
  latency_checkpoint: 'typically ~3–20s wall-clock (provider-dependent)',
  latency_standard: 'typically ~5–45s wall-clock (cascade; provider-dependent)',
} as const;

export const TIER_CONFIGS: Record<SentinelTier, TierConfig> = {
  checkpoint: {
    tier: 'checkpoint',
    label: 'Checkpoint',
    price_usd: 0.005,
    cascade: ['serv-nano'],
    accuracy: CAL.checkpoint_acc,
    accuracy_n: CAL.checkpoint_n,
    accuracy_suite: CAL.checkpoint_suite,
    false_allows: CAL.fa,
    false_allows_n: CAL.fa_n,
    latency_typical: CAL.latency_checkpoint,
    latency_median: CAL.latency_checkpoint,
    default: false,
    notes: `Nano solo. High-volume, individually lower-stakes. ${CAL.fa_suite_note}`,
  },
  standard: {
    tier: 'standard',
    label: 'Standard',
    price_usd: 0.008,
    cascade: ['serv-nano', 'serv-swift'],
    accuracy: CAL.standard_acc,
    accuracy_n: CAL.standard_n,
    accuracy_suite: CAL.standard_suite,
    false_allows: CAL.fa,
    false_allows_n: CAL.fa_n,
    latency_typical: CAL.latency_standard,
    latency_median: CAL.latency_standard,
    default: true,
    notes: `Nano→Swift cascade (default). ${CAL.fa_suite_note}`,
  },
  pro: {
    tier: 'pro',
    label: 'Pro',
    price_usd: 0.008,
    cascade: ['serv-nano', 'serv-pro'],
    accuracy: CAL.standard_acc,
    accuracy_n: CAL.standard_n,
    accuracy_suite: CAL.standard_suite,
    false_allows: CAL.fa,
    false_allows_n: CAL.fa_n,
    latency_typical: CAL.latency_standard,
    latency_median: CAL.latency_standard,
    default: false,
    hidden: true,
    notes: 'Nano→Pro cascade. Reserved — not publicly listed.',
  },
  swift: {
    tier: 'swift',
    label: 'Swift',
    price_usd: 0.008,
    cascade: ['serv-nano', 'serv-swift'],
    accuracy: CAL.standard_acc,
    accuracy_n: CAL.standard_n,
    accuracy_suite: CAL.standard_suite,
    false_allows: CAL.fa,
    false_allows_n: CAL.fa_n,
    latency_typical: CAL.latency_standard,
    latency_median: CAL.latency_standard,
    default: false,
    hidden: true,
    notes: 'Internal alias of standard — not publicly listed.',
  },
};

export function getTierConfig(tier?: SentinelTier): TierConfig {
  return TIER_CONFIGS[tier ?? 'standard'];
}

/** Public tier listing — excludes hidden tiers (swift, pro). */
export function listTiers(): TierConfig[] {
  return Object.values(TIER_CONFIGS).filter((t) => !t.hidden);
}

/** All tiers including hidden — for internal routing/validation. */
export function listAllTiers(): TierConfig[] {
  return Object.values(TIER_CONFIGS);
}
