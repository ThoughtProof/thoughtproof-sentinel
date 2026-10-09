import type { SentinelTier } from './types.js';

export interface TierConfig {
  tier: SentinelTier;
  label: string;
  price_usd: number;
  cascade: string[];
  accuracy: number;
  false_allows: number;
  /**
   * Advertised end-to-end latency (string).
   * Measured prod: deterministic BLOCK is 2–4 s; every standard-tier ALLOW
   * is 8.2–14.6 s (median 10.6 s), so cascade work including all ALLOWs
   * is ~8–15 s. The hard stop is ENGINE_BUDGET_MS (45s) inside the 60s
   * Vercel maxDuration. On exhaustion the wire verdict is UNCERTAIN
   * (product REVIEW) unless a BLOCK is already known or the
   * objective-mismatch gate fires. Never ALLOW.
   */
  latency_median: string;
  default: boolean;
  /** When true, the tier is routable (accepted by /verify) but NOT advertised
   *  in the public /tiers listing. Used to keep internal/experiment cascades
   *  (swift, pro) addressable without exposing them as customer-facing options. */
  hidden?: boolean;
  notes: string;
}

/**
 * Copy returned by GET /sentinel/tiers (`latency_median` stays a string).
 * 45s is `ENGINE_BUDGET_MS` in src/engine/budget.ts. Exhaustion returns
 * wire UNCERTAIN (product language REVIEW) via publicVerdictOnBudgetExhaust,
 * except an already-known BLOCK (and an objective-mismatch gate) which stay
 * BLOCK. Never ALLOW.
 */
export const ADVERTISED_LATENCY_MEDIAN =
  '2–4 s for deterministic BLOCK; ~8–15 s with cascade (incl. all ALLOWs); 45 s engine budget → UNCERTAIN (REVIEW); known BLOCK or objective mismatch stays BLOCK';

export const TIER_CONFIGS: Record<SentinelTier, TierConfig> = {
  checkpoint: {
    tier: 'checkpoint',
    label: 'Checkpoint',
    price_usd: 0.005,
    cascade: ['serv-nano'],
    accuracy: 0.833,
    false_allows: 0,
    latency_median: ADVERTISED_LATENCY_MEDIAN,
    default: false,
    notes: 'Nano solo. High-volume, individually low-stakes checks.',
  },
  // Standard is the default customer-facing tier. It runs the Nano->Swift
  // cascade internally (same calibration as the legacy Nano->Pro, 0 false
  // ALLOWs, lower COGS). Customers see one cascade tier; the underlying
  // secondary model is an implementation detail.
  standard: {
    tier: 'standard',
    label: 'Standard',
    price_usd: 0.008,
    cascade: ['serv-nano', 'serv-swift'],
    accuracy: 0.813,
    false_allows: 0,
    latency_median: ADVERTISED_LATENCY_MEDIAN,
    default: true,
    notes: 'Nano→cascade. Default Sentinel tier. 0 False ALLOWs.',
  },
  // Hidden: the legacy Nano->Pro cascade. Kept routable as a reserved premium /
  // enterprise option, but not advertised in /tiers. Same price as standard.
  pro: {
    tier: 'pro',
    label: 'Pro',
    price_usd: 0.008,
    cascade: ['serv-nano', 'serv-pro'],
    accuracy: 0.813,
    false_allows: 0,
    latency_median: ADVERTISED_LATENCY_MEDIAN,
    default: false,
    hidden: true,
    notes: 'Nano→Pro cascade. Reserved premium/enterprise tier — not publicly listed.',
  },
  // Hidden: retained so existing callers that explicitly send tier="swift"
  // (e.g. the cb4a swift-vs-standard A/B experiment) keep working. Now
  // identical to standard's cascade. Not advertised in /tiers.
  swift: {
    tier: 'swift',
    label: 'Swift',
    price_usd: 0.008,
    cascade: ['serv-nano', 'serv-swift'],
    accuracy: 0.813,
    false_allows: 0,
    latency_median: ADVERTISED_LATENCY_MEDIAN,
    default: false,
    hidden: true,
    notes: 'Nano→Swift cascade. Internal alias of standard — not publicly listed.',
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
