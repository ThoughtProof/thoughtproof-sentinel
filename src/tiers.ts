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
  standard: {
    tier: 'standard',
    label: 'Standard',
    price_usd: 0.008,
    cascade: ['serv-nano', 'serv-pro'],
    accuracy: 0.813,
    false_allows: 0,
    latency_median: '1.3s',
    default: true,
    notes: 'Nano→Pro cascade. Default Sentinel tier. 0 False ALLOWs.',
  },
};

export function getTierConfig(tier?: SentinelTier): TierConfig {
  return TIER_CONFIGS[tier ?? 'standard'];
}

export function listTiers(): TierConfig[] {
  return Object.values(TIER_CONFIGS);
}
