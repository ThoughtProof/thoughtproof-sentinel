/**
 * Tests for Payment Adapters (Stripe skeleton)
 * x402 tests moved — x402 is now middleware, not an adapter.
 */

import { describe, it, expect } from 'vitest';
import { StripePaymentAdapter } from './payment/stripe.js';
import type { BillingEvent } from '../types.js';

function makeBillingEvent(overrides?: Partial<BillingEvent>): BillingEvent {
  return {
    verification_id: 'sent_test001',
    tier: 'checkpoint',
    price_usd: 0.005,
    mode: 'handoff',
    models_used: ['serv-nano'],
    duration_ms: 800,
    timestamp: '2026-05-13T19:00:00.000Z',
    platform: 'direct',
    ...overrides,
  };
}

describe('StripePaymentAdapter', () => {
  it('records usage without settling', async () => {
    const adapter = new StripePaymentAdapter();
    const result = await adapter.process(makeBillingEvent());

    expect(result.settled).toBe(false);
    expect(result.reference).toContain('usage:');
    expect(adapter.pendingCount).toBe(1);
  });

  it('flush clears usage records', async () => {
    const adapter = new StripePaymentAdapter();

    await adapter.process(makeBillingEvent({ verification_id: 'sent_1' }));
    await adapter.process(makeBillingEvent({ verification_id: 'sent_2' }));

    const result = await adapter.flush();
    expect(result.settled_count).toBe(2);
    expect(adapter.pendingCount).toBe(0);
  });
});
