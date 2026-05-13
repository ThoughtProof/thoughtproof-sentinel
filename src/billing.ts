/**
 * Billing Event Builder
 *
 * Creates a BillingEvent from engine response + platform context.
 * Called by the route layer — NOT by the engine.
 */

import type { BillingEvent, PaymentPlatform, SentinelVerifyResponse } from './types.js';
import { TIER_CONFIGS } from './tiers.js';

export interface BillingContext {
  platform: PaymentPlatform;
  agent_id?: string;
}

/**
 * Build a BillingEvent from a verification response.
 * The route layer calls this after engine.verify() returns.
 */
export function buildBillingEvent(
  response: SentinelVerifyResponse,
  context: BillingContext,
): BillingEvent {
  const tierConfig = TIER_CONFIGS[response.tier];

  return {
    verification_id: response.id,
    tier: response.tier,
    price_usd: tierConfig.price_usd,
    mode: response.mode,
    models_used: response.meta.models_used,
    duration_ms: response.meta.duration_ms,
    timestamp: response.meta.verified_at,
    platform: context.platform,
    agent_id: context.agent_id,
  };
}
