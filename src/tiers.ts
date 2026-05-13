import type { SentinelTier } from './types.js';

export interface TierConfig {
  tier: SentinelTier;
  label: string;
  price_usd: number;
  cascade: string[];
  accuracy: number;
  false_allows: number;
  latency_median: string;
  default: boolean;
  notes: string;
}

/**
 * SERV model labels → pot-cli model-router aliases.
 *
 * Sentinel's tier config uses SERV labels (nano, pro) for product consistency.
 * The engine resolves these to pot-cli aliases at runtime via this map.
 *
 * SERV "nano" = binary classifier, fast/cheap → gemini (gemini-3.1-flash-lite)
 * SERV "pro"  = custom/fast, 720ms backing   → sonnet (claude-sonnet-4-6)
 *
 * When SERV models are available as first-class pot-cli aliases (e.g. after
 * pot-cli adds native SERV support), update this map — no cascade logic changes.
 */
export const SERV_TO_POTCLI: Record<string, string> = {
  nano: 'gemini',
  pro: 'sonnet',
};

export function resolveCascadeModels(cascade: string[]): string[] {
  return cascade.map(model => SERV_TO_POTCLI[model] ?? model);
}

export const TIER_CONFIGS: Record<SentinelTier, TierConfig> = {
  checkpoint: {
    tier: 'checkpoint',
    label: 'Checkpoint',
    price_usd: 0.003,
    cascade: ['nano'],
    accuracy: 0.833,
    false_allows: 0,
    latency_median: '0.9s',
    default: false,
    notes: 'Nano solo. High-volume, individually low-stakes checks. ~80% margin at $0.003.',
  },
  standard: {
    tier: 'standard',
    label: 'Standard',
    price_usd: 0.005,
    cascade: ['nano', 'pro'],
    accuracy: 0.813,
    false_allows: 0,
    latency_median: '1.3s',
    default: true,
    notes: 'Nano→Pro cascade. Default Sentinel tier. 0 False ALLOWs, ~70% margin at $0.005.',
  },
};

export function getTierConfig(tier?: SentinelTier): TierConfig {
  return TIER_CONFIGS[tier ?? 'standard'];
}

export function listTiers(): TierConfig[] {
  return Object.values(TIER_CONFIGS);
}
