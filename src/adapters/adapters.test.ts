/**
 * Tests for Payment Adapters (x402 + Stripe skeletons)
 */

import { describe, it, expect } from 'vitest';
import { X402PaymentAdapter } from './payment/x402.js';
import { StripePaymentAdapter } from './payment/stripe.js';
import type { BillingEvent } from '../types.js';

function makeBillingEvent(overrides?: Partial<BillingEvent>): BillingEvent {
  return {
    verification_id: 'sent_test001',
    tier: 'checkpoint',
    price_usd: 0.003,
    mode: 'handoff',
    models_used: ['serv-nano'],
    duration_ms: 800,
    timestamp: '2026-05-13T19:00:00.000Z',
    platform: 'direct',
    ...overrides,
  };
}

describe('X402PaymentAdapter', () => {
  it('defers settlement below batch size', async () => {
    const adapter = new X402PaymentAdapter({ batchSize: 10 });
    const result = await adapter.process(makeBillingEvent());

    expect(result.settled).toBe(false);
    expect(adapter.pendingCount).toBe(1);
  });

  it('auto-flushes at batch size', async () => {
    const adapter = new X402PaymentAdapter({ batchSize: 3 });

    await adapter.process(makeBillingEvent({ verification_id: 'sent_1' }));
    await adapter.process(makeBillingEvent({ verification_id: 'sent_2' }));
    const result = await adapter.process(makeBillingEvent({ verification_id: 'sent_3' }));

    expect(result.settled).toBe(true);
    expect(result.reference).toBe('batch:3');
    expect(adapter.pendingCount).toBe(0);
  });

  it('flush returns 0 when empty', async () => {
    const adapter = new X402PaymentAdapter();
    const result = await adapter.flush();

    expect(result.settled_count).toBe(0);
    expect(result.tx_hash).toBeUndefined();
  });

  it('flush clears batch', async () => {
    const adapter = new X402PaymentAdapter({ batchSize: 100 });

    await adapter.process(makeBillingEvent({ verification_id: 'sent_1' }));
    await adapter.process(makeBillingEvent({ verification_id: 'sent_2' }));

    expect(adapter.pendingCount).toBe(2);

    const result = await adapter.flush();
    expect(result.settled_count).toBe(2);
    expect(adapter.pendingCount).toBe(0);
  });

  it('tracks batch age', async () => {
    const adapter = new X402PaymentAdapter();

    expect(adapter.batchAgeMs).toBeNull();

    await adapter.process(makeBillingEvent());
    expect(adapter.batchAgeMs).toBeGreaterThanOrEqual(0);
  });
});

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
