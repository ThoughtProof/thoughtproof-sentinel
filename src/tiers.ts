import type { SentinelTier } from './types.js';

export interface TierConfig {
  tier: SentinelTier;
  label: string;
  price_usd: number;
  cascade: string[];
  accuracy: number;
  false_allows: number;
  /**
   * Advertised end-to-end latency (string). Per tier — the standard ALLOW
   * sample does not apply to checkpoint. 45s is ENGINE_BUDGET_MS. Exhaustion
   * returns wire UNCERTAIN (product REVIEW) unless a BLOCK is already known
   * or the objective-mismatch gate fires. Never ALLOW.
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
 * Shared budget clause. 45s is ENGINE_BUDGET_MS. Wire verdict on exhaustion
 * is UNCERTAIN (product REVIEW) unless BLOCK is already known or the
 * objective-mismatch gate fires. Never ALLOW.
 */
const ENGINE_BUDGET_LATENCY =
  '45 s engine budget → UNCERTAIN (REVIEW); known BLOCK or objective mismatch stays BLOCK';

/** Observed prod range. Sample size was not recorded; not a guarantee. */
const OBSERVED_DETERMINISTIC_BLOCK =
  'Deterministic BLOCK: observed prod range 2–4 s (sample size not recorded)';

/**
 * Checkpoint is serv-nano only (stages.length === 1). No measured
 * checkpoint latency sample is in the repo.
 */
export const CHECKPOINT_ADVERTISED_LATENCY =
  `Nano-only, no cascade. Nano-path latency not yet measured. ${OBSERVED_DETERMINISTIC_BLOCK}. ${ENGINE_BUDGET_LATENCY}`;

/**
 * Standard (and the hidden swift alias) run serv-nano → serv-swift.
 * ALLOW figures are one named sample, not a guarantee.
 */
export const STANDARD_ADVERTISED_LATENCY =
  `Nano→Swift cascade. ${OBSERVED_DETERMINISTIC_BLOCK}. Standard ALLOWs: observed in prod live suite 8–9 Oct 2026, n=28 standard ALLOWs, 8.2–14.6 s, median 10.6 s. ${ENGINE_BUDGET_LATENCY}`;

/** Hidden legacy serv-nano → serv-pro. No separate latency sample. */
export const PRO_ADVERTISED_LATENCY =
  `Hidden Nano→Pro cascade. Cascade latency not yet measured. ${OBSERVED_DETERMINISTIC_BLOCK}. ${ENGINE_BUDGET_LATENCY}`;

export const TIER_CONFIGS: Record<SentinelTier, TierConfig> = {
  checkpoint: {
    tier: 'checkpoint',
    label: 'Checkpoint',
    price_usd: 0.005,
    cascade: ['serv-nano'],
    accuracy: 0.833,
    false_allows: 0,
    latency_median: CHECKPOINT_ADVERTISED_LATENCY,
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
    latency_median: STANDARD_ADVERTISED_LATENCY,
    default: true,
    notes: 'Nano→Swift cascade. Default Sentinel tier. 0 False ALLOWs.',
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
    latency_median: PRO_ADVERTISED_LATENCY,
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
    latency_median: STANDARD_ADVERTISED_LATENCY,
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
