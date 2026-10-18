import type { SentinelMode, SentinelTier } from './types.js';

export interface TierConfig {
  tier: SentinelTier;
  label: string;
  price_usd: number;
  cascade: string[];
  accuracy: number;
  false_allows: number;
  latency_median: string;
  default: boolean;
  /** When true, the tier is routable (accepted by /verify) but NOT advertised
   *  in the public /tiers listing. Used to keep internal/experiment cascades
   *  (swift, pro) addressable without exposing them as customer-facing options. */
  hidden?: boolean;
  notes: string;
}

export const TIER_CONFIGS: Record<SentinelTier, TierConfig> = {
  checkpoint: {
    tier: 'checkpoint',
    label: 'Checkpoint',
    price_usd: 0.005,
    cascade: ['serv-nano'],
    accuracy: 0.833,
    false_allows: 0,
    latency_median: '0.9s',
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
    latency_median: '1.2s',
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
    latency_median: '1.3s',
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
    latency_median: '1.2s',
    default: false,
    hidden: true,
    notes: 'Nano→Swift cascade. Internal alias of standard — not publicly listed.',
  },
};

export function getTierConfig(tier?: SentinelTier): TierConfig {
  return TIER_CONFIGS[tier ?? 'standard'];
}

// Exact IDs observed in the authenticated OpenServ catalog. These are routes,
// not qualified production defaults. A missing/unpriced ID must not alias to Sol.
const NAMED_OPENSERV_TRADE_MODELS = ['openserv/gpt-6-sol', 'openserv/gpt-6-astra'];

/** Deployment-only selection for a single trade checkpoint evaluator.
 * Public tier defaults and all other modes remain unchanged. Never silently
 * fall back to Nano when a configured model is invalid or unavailable.
 */
export function getCascadeModels(tier: SentinelTier, mode?: SentinelMode): string[] {
  const selected = process.env.SENTINEL_TRADE_CHECKPOINT_MODEL;
  if (mode === 'trade_execution' && tier === 'checkpoint' && selected !== undefined) {
    if (!['serv-nano', 'serv-swift', 'serv-pro', ...NAMED_OPENSERV_TRADE_MODELS].includes(selected)) {
      throw new Error('INVALID_TRADE_CHECKPOINT_MODEL');
    }
    return [selected];
  }
  return [...TIER_CONFIGS[tier].cascade];
}

/** Only the new named routes accept an explicit reasoning budget. */
export function getTradeCheckpointReasoningEffort(
  tier: SentinelTier, mode?: SentinelMode,
): 'low' | 'medium' | 'high' | undefined {
  if (mode !== 'trade_execution' || tier !== 'checkpoint') return undefined;
  const configured = process.env.SENTINEL_TRADE_CHECKPOINT_REASONING_EFFORT;
  const named = NAMED_OPENSERV_TRADE_MODELS.includes(process.env.SENTINEL_TRADE_CHECKPOINT_MODEL ?? '');
  if (!named && configured === undefined) return undefined;
  const effort = configured ?? 'low';
  if (!named || !['low', 'medium', 'high'].includes(effort)) {
    throw new Error('INVALID_TRADE_CHECKPOINT_REASONING_EFFORT');
  }
  return effort as 'low' | 'medium' | 'high';
}

/** Public tier listing — excludes hidden tiers (swift, pro). */
export function listTiers(): TierConfig[] {
  return Object.values(TIER_CONFIGS).filter((t) => !t.hidden);
}

/** All tiers including hidden — for internal routing/validation. */
export function listAllTiers(): TierConfig[] {
  return Object.values(TIER_CONFIGS);
}
