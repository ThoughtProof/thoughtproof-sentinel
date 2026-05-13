/**
 * Stripe Payment Adapter (Skeleton)
 *
 * Invoice-based billing for enterprise Sentinel customers.
 * Implements ADR-0017 payment adapter interface.
 *
 * STATUS: Skeleton — awaits Stripe integration.
 * Current behavior: logs billing events, defers to monthly invoice.
 */

import type { BillingEvent, PaymentAdapter } from '../../types.js';

export interface StripeConfig {
  /** Stripe API key (from env) */
  apiKey?: string;
  /** Stripe customer ID mapping */
  customerId?: string;
}

export class StripePaymentAdapter implements PaymentAdapter {
  private readonly config: StripeConfig;
  private usageRecords: BillingEvent[] = [];

  constructor(config?: StripeConfig) {
    this.config = config ?? {};
  }

  async process(event: BillingEvent): Promise<{ settled: boolean; reference?: string }> {
    // Stripe metered billing: record usage, settle on invoice cycle
    this.usageRecords.push(event);

    // TODO: When Stripe integration is ready:
    // 1. Create usage record via Stripe API
    // 2. Return Stripe usage record ID as reference
    console.log(`[stripe] usage recorded: ${event.verification_id} — SKELETON (not sent to Stripe)`);

    return { settled: false, reference: `usage:${event.verification_id}` };
  }

  async flush(): Promise<{ settled_count: number; tx_hash?: string }> {
    const count = this.usageRecords.length;

    // TODO: Trigger invoice generation or sync usage records
    console.log(`[stripe] flush: ${count} usage records — SKELETON`);

    this.usageRecords = [];
    return { settled_count: count };
  }

  /** Pending usage records count */
  get pendingCount(): number {
    return this.usageRecords.length;
  }
}
