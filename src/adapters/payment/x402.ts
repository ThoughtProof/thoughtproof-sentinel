/**
 * x402 Payment Adapter (Skeleton)
 *
 * Batch settlement for sub-cent Sentinel verification payments.
 * Implements ADR-0017 payment adapter interface.
 *
 * STATUS: Skeleton — awaits x402 SDK availability.
 * Current behavior: logs billing events, defers settlement.
 */

import type { BillingEvent, PaymentAdapter } from '../../types.js';

export interface X402Config {
  /** x402 escrow contract address */
  escrowAddress: string;
  /** Batch size threshold before auto-flush */
  batchSize: number;
  /** Max batch age in ms before auto-flush */
  batchMaxAgeMs: number;
}

const DEFAULT_CONFIG: X402Config = {
  escrowAddress: '0x0000000000000000000000000000000000000000', // TBD
  batchSize: 100,
  batchMaxAgeMs: 3600_000, // 1 hour
};

export class X402PaymentAdapter implements PaymentAdapter {
  private readonly config: X402Config;
  private batch: BillingEvent[] = [];
  private batchStartedAt: number | null = null;

  constructor(config?: Partial<X402Config>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async process(event: BillingEvent): Promise<{ settled: boolean; reference?: string }> {
    this.batch.push(event);
    if (this.batchStartedAt === null) {
      this.batchStartedAt = Date.now();
    }

    // Auto-flush if batch is full
    if (this.batch.length >= this.config.batchSize) {
      const result = await this.flush();
      return { settled: true, reference: `batch:${result.settled_count}` };
    }

    // Deferred — will settle in next flush
    return { settled: false };
  }

  async flush(): Promise<{ settled_count: number; tx_hash?: string }> {
    if (this.batch.length === 0) {
      return { settled_count: 0 };
    }

    const count = this.batch.length;
    const totalUsd = this.batch.reduce((sum, e) => sum + e.price_usd, 0);

    // TODO: When x402 SDK is available:
    // 1. Encode batch into x402 settlement transaction
    // 2. Submit to escrow contract
    // 3. Return actual tx_hash
    console.log(`[x402] flush: ${count} events, total $${totalUsd.toFixed(4)} — SKELETON (not settled on-chain)`);

    this.batch = [];
    this.batchStartedAt = null;

    return { settled_count: count, tx_hash: undefined };
  }

  /** Current batch size (for monitoring) */
  get pendingCount(): number {
    return this.batch.length;
  }

  /** Current batch age in ms (null if empty) */
  get batchAgeMs(): number | null {
    return this.batchStartedAt ? Date.now() - this.batchStartedAt : null;
  }
}
