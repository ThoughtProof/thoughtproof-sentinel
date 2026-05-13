# Payment Adapters

Settlement layer for Sentinel verifications. See [ADR-0017](../../docs/ADR-0017-payment-adapter-layer.md).

## Architecture

Payment is **orthogonal to platform**. Any platform adapter (OpenServ, ACP) composes with any payment adapter (x402, Stripe). The engine never sees either.

```
Route → Platform Adapter (auth) → Engine (verify) → Payment Adapter (bill)
```

## Adapters

| Adapter | Status | Use Case |
|---------|--------|----------|
| `x402.ts` | Skeleton | Batch escrow settlement for agentic customers ($0.003-0.005/call) |
| `stripe.ts` | Skeleton | Invoice-based billing for enterprise customers |

## Implementation Priority

1. **x402** — when first agentic customer needs autonomous payment
2. **Stripe** — when first enterprise customer needs monthly invoicing

Both are no-ops in Phase 0 (AMA demo — open auth, no billing).
