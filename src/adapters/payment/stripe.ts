/**
 * Stripe Payment Adapter
 *
 * Submits usage-based billing events to Stripe Billing Meter Events API.
 * Follows the same pattern as thoughtproof-api-v2/src/billing.ts.
 *
 * Env vars:
 *   STRIPE_SECRET_KEY       — Stripe API secret key (sk_live_... or sk_test_...)
 *   STRIPE_METER_EVENT_NAME — Meter event name (e.g. 'sentinel_verification')
 *   STRIPE_CUSTOMER_MAP     — CSV mapping: "platform:cus_xxx,platform2:cus_yyy"
 *
 * When any env var is missing, Stripe calls are silently skipped.
 * Stripe errors never block the verification response.
 */

import type { BillingEvent, PaymentAdapter } from '../../types.js';

const STRIPE_METER_EVENTS_URL = 'https://api.stripe.com/v1/billing/meter_events';

export class StripePaymentAdapter implements PaymentAdapter {
  private usageRecords: BillingEvent[] = [];

  async process(event: BillingEvent): Promise<{ settled: boolean; reference?: string }> {
    this.usageRecords.push(event);

    // Submit to Stripe Meter Events API
    const submitted = await submitStripeMeterEvent(event);

    if (submitted) {
      return { settled: false, reference: `stripe_meter:${event.verification_id}` };
    }

    // Stripe not configured or call failed — still track locally
    return { settled: false, reference: `usage:${event.verification_id}` };
  }

  async flush(): Promise<{ settled_count: number; tx_hash?: string }> {
    const count = this.usageRecords.length;
    this.usageRecords = [];
    return { settled_count: count };
  }

  get pendingCount(): number {
    return this.usageRecords.length;
  }
}

/**
 * Submit a single billing event to Stripe Billing Meter Events.
 * Returns true if submitted, false if skipped (missing config) or failed.
 * Never throws — errors are logged and swallowed.
 */
async function submitStripeMeterEvent(event: BillingEvent): Promise<boolean> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const eventName = process.env.STRIPE_METER_EVENT_NAME;
  const customerId = lookupStripeCustomerId(event.platform);

  if (!secretKey || !eventName || !customerId) {
    return false;
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
      return false;
    }

    console.log(JSON.stringify({
      event: 'stripe_meter_event_submitted',
      verification_id: event.verification_id,
      tier: event.tier,
      unit_amount_cents: unitAmountCents,
      platform: event.platform,
      timestamp: new Date().toISOString(),
    }));

    return true;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'stripe_meter_event_error',
      verification_id: event.verification_id,
      platform: event.platform,
      error: error instanceof Error ? error.message : 'Unknown Stripe error',
      timestamp: new Date().toISOString(),
    }));
    return false;
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
