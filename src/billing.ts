/**
 * Billing Event Builder + Stripe Submission
 *
 * Creates a BillingEvent from engine response + platform context,
 * then optionally submits to Stripe Meter Events API.
 *
 * Called by the route layer — NOT by the engine.
 */

import type { BillingEvent, PaymentPlatform, SentinelVerifyResponse } from './types.js';
import { TIER_CONFIGS } from './tiers.js';

const STRIPE_METER_EVENTS_URL = 'https://api.stripe.com/v1/billing/meter_events';

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

/**
 * Record a billing event: log structured JSON + submit to Stripe if configured.
 * Stripe errors never throw — they're logged and swallowed.
 */
export async function recordBillingEvent(event: BillingEvent): Promise<void> {
  logBillingEvent(event);
  await submitStripeMeterEvent(event);
}

function logBillingEvent(event: BillingEvent): void {
  console.log(JSON.stringify({
    event: 'sentinel_billing_event',
    ...event,
  }));
}

/**
 * Submit a billing event to Stripe Billing Meter Events API.
 * Silently skips if STRIPE_SECRET_KEY, STRIPE_METER_EVENT_NAME,
 * or STRIPE_CUSTOMER_MAP are not configured.
 */
async function submitStripeMeterEvent(event: BillingEvent): Promise<void> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const eventName = process.env.STRIPE_METER_EVENT_NAME;
  const customerId = lookupStripeCustomerId(event.platform);

  if (!secretKey || !eventName || !customerId) {
    return;
  }

  const unitAmountCents = Math.round(event.price_usd * 100);

  const body = new URLSearchParams();
  body.set('event_name', eventName);
  body.set('identifier', event.verification_id);
  body.set('payload[stripe_customer_id]', customerId);
  body.set('payload[value]', String(unitAmountCents));
  body.set('payload[verification_id]', event.verification_id);
  body.set('payload[tier]', event.tier);
  body.set('payload[mode]', event.mode);
  body.set('payload[platform]', event.platform);
  if (event.agent_id) {
    body.set('payload[agent_id]', event.agent_id);
  }

  try {
    const response = await fetch(STRIPE_METER_EVENTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(JSON.stringify({
        event: 'stripe_meter_event_error',
        verification_id: event.verification_id,
        platform: event.platform,
        status: response.status,
        error: text.slice(0, 500),
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    console.log(JSON.stringify({
      event: 'stripe_meter_event_submitted',
      verification_id: event.verification_id,
      tier: event.tier,
      unit_amount_cents: unitAmountCents,
      platform: event.platform,
      timestamp: new Date().toISOString(),
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'stripe_meter_event_error',
      verification_id: event.verification_id,
      platform: event.platform,
      error: error instanceof Error ? error.message : 'Unknown Stripe error',
      timestamp: new Date().toISOString(),
    }));
  }
}

/**
 * Lookup Stripe customer ID from STRIPE_CUSTOMER_MAP env var.
 * Format: "openserv:cus_xxx,acp:cus_yyy,direct:cus_zzz"
 */
function lookupStripeCustomerId(platform: string): string | undefined {
  const raw = process.env.STRIPE_CUSTOMER_MAP;
  if (!raw) return undefined;

  for (const entry of raw.split(',')) {
    const [key, customerId] = entry.split(':').map(part => part.trim());
    if (key === platform && customerId) return customerId;
  }

  return undefined;
}
