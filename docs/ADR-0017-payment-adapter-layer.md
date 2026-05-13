# ADR-0017: Payment Adapter Layer

**Status:** Proposed
**Date:** 2026-05-13
**Decision Makers:** Raul Jäger (Founder)
**Related:** ADR-0013 (Payment Architecture), ADR-0016 (Sentinel API Spec)

---

## Context

Sentinel's verification pricing ($0.003 checkpoint, $0.005 standard) creates a unit-economics problem: at sub-cent price points, per-call on-chain payment transactions can cost more in gas than the verification itself.

On 2026-05-13, x402 announced batch settlement support — escrow once, settle fractions of a cent per call, batch on-chain. This solves Sentinel's payment scalability, but introduces an architectural question: where does payment logic live?

The naive approach puts payment handling inside platform adapters (OpenServ, ACP). This is wrong. A Cobot-style agent on OpenServ might pay via x402. An enterprise customer might pay via Stripe invoice. The same engine, the same platform integration — different payment rail. **Payment is orthogonal to platform.**

---

## Decision

### 1. Two-Axis Adapter Architecture

Adapters split into two independent axes:

```
adapters/
├── platform/           ← WHO calls Sentinel (auth, lifecycle, webhooks)
│   ├── openserv.ts     ← X-Sentinel-Key, webhook signatures
│   └── acp.ts          ← Virtuals job lifecycle, ACP protocol
└── payment/            ← HOW they pay (settlement, billing, metering)
    ├── x402.ts         ← Batch escrow settlement (on-chain, sub-cent)
    └── stripe.ts       ← Invoice-based billing (enterprise, monthly)
```

**Composition rule:** Any platform adapter composes with any payment adapter. The engine never sees either.

| Customer Type | Platform Adapter | Payment Adapter |
|---|---|---|
| OpenServ agent (agentic) | `platform/openserv` | `payment/x402` |
| ACP agent on Virtuals | `platform/acp` | `payment/x402` |
| Enterprise API customer | `platform/openserv` | `payment/stripe` |
| AMA demo | none (open) | none (free) |

### 2. Dependency Direction

```
Routes → Platform Adapter (auth) → Engine (verification) → Payment Adapter (billing event)
```

Strict rules:
- Engine NEVER imports from `adapters/platform/` or `adapters/payment/`
- Platform adapters NEVER import from `adapters/payment/` (and vice versa)
- Routes compose both: authenticate via platform adapter, verify via engine, bill via payment adapter
- Payment adapters receive a `BillingEvent` emitted by the route layer, not by the engine

### 3. BillingEvent Interface

```typescript
interface BillingEvent {
  verification_id: string;      // sent_abc123
  tier: 'checkpoint' | 'standard';
  price_usd: number;            // 0.003 or 0.005
  mode: VerificationMode;
  models_used: string[];        // ['nano'] or ['nano', 'pro']
  duration_ms: number;
  timestamp: string;            // ISO 8601
  platform: 'openserv' | 'acp' | 'direct';  // attribution for per-platform revenue reporting
  agent_id?: string;            // platform-specific identifier (e.g. OpenServ agent ID, ACP agent address)
}
```

The route layer creates this from the engine's `VerificationResponse` and the platform adapter's auth context, then passes it to the active payment adapter. The engine returns verification results; it has no concept of money or platform identity.

### 4. x402 Batch Settlement Economics

**Scenario:** Cobot-style autonomous trading agent, 200 plan_revision checks/day at Sentinel Checkpoint ($0.003).

**Without batch settlement (median conditions):**
- Revenue: 200 × $0.003 = **$0.60/day**
- Gas cost: 200 on-chain tx × ~$0.0003 (Base L2 median, 0.005-0.05 gwei) = **$0.06/day**
- Gas as % of revenue: **~10%**
- Effective margin: ~70% (after LLM cost + gas)

**Without batch settlement (congestion, 5-50x spike):**
- Gas cost: 200 on-chain tx × ~$0.005 (5 gwei) = **$1.00/day**
- Gas as % of revenue: **167%** — **verification runs at a loss**

**With x402 batch settlement:**
- Revenue: 200 × $0.003 = **$0.60/day**
- Gas cost: 1 escrow tx + 1 batch settle tx = **~$0.002/day**
- Gas as % of revenue: **<0.4%** (median or congestion — amortized either way)
- Effective margin: **~80%** (LLM cost only meaningful variable)

**At scale (1,000 checks/day):**
- Revenue: $3.00/day, gas still ~$0.002 → margin approaches LLM-cost floor (~82%)

Gas estimate uses median Base L2 conditions. Under network congestion (5–50x spike), per-tx cost can exceed verification revenue entirely — batch settlement removes this tail risk, not just the median cost.

Batch settlement turns Sentinel from "congestion-vulnerable at sub-cent price points" to "viable at any volume, any network condition."

### 5. x402 Composes With — Does Not Compete With — Platforms

This must be explicit: **x402 is not an alternative to OpenServ or ACP.** It operates on a different axis entirely.

- OpenServ/ACP answer: *which platform does this agent live on?*
- x402/Stripe answer: *how does payment settle?*

An OpenServ-native agent paying via x402 is the expected composition, not an either/or choice. This is why the Virtuals outreach correctly omitted x402 — it's a payment implementation detail, not a platform positioning statement.

---

## Decision Drivers

1. **Orthogonality.** Payment and platform are independent axes. Coupling them forces code duplication when the second payment rail arrives.
2. **Unit economics.** Sub-cent verifications are only viable with batched settlement. x402 batch support (2026-05-13) makes this concrete, not theoretical.
3. **Composability.** Enterprise customers want Stripe invoices. Agentic customers want x402. Same engine, same platform adapter, different payment rail. One variable changes, one adapter swaps.
4. **Testability.** Engine tests need zero payment mocks. Payment adapter tests need zero engine mocks. Platform adapter tests need zero payment mocks. Each axis tested in isolation.

---

## Consequences

### Positive
- Engine stays pure — `VerificationRequest → VerificationResponse`, no side effects
- Adding a payment rail (Stripe, x402, future USDC direct) is 1 adapter file + route wiring
- Adding a platform (ACP, gRPC, webhook) doesn't touch payment logic at all
- Unit economics are viable from day one at sub-cent price points

### Negative
- Slightly more directory structure than a monolithic `adapters/` folder
- Route layer has more composition responsibility (auth + verify + bill)
- BillingEvent interface must stay stable across payment adapters

### Open Questions

- **Payment adapter selection mechanism:** Per-request header vs. per-API-key attribute vs. per-customer-profile? Intentionally deferred. To be decided when first payment adapter ships. Must not be solved ad-hoc during implementation — this ADR should be updated with the decision before the Stripe or x402 adapter merges.

### Neutral
- Phase 0 (AMA demo) uses neither — open auth, no billing. Both axes are no-ops.
- Stripe adapter priority depends on enterprise pipeline timing (post-AMA)

---

## Implementation Sequence

1. Engine wiring (pure, no adapters) — post-AMA
2. `platform/openserv.ts` — Phase 1 auth (X-Sentinel-Key)
3. `payment/x402.ts` — when first agentic customer needs autonomous payment
4. `payment/stripe.ts` — when first enterprise customer needs invoicing
5. `platform/acp.ts` — when Virtuals integration is concrete

Each step is independent. No step blocks another.

---

## Action Items

1. [x] Update `ENGINE-ARCHITECTURE.md` to reference this ADR (remove inline x402 section)
2. [x] Create `adapters/platform/` and `adapters/payment/` directory structure
3. [x] Define `BillingEvent` in `types.ts`
4. [x] Engine wiring PR uses this structure from the start

---

## References

- ADR-0013: Payment Architecture
- ADR-0016: Sentinel API Spec
- x402 Batch Settlement: @Jnix2007, @fabdarice (2026-05-13)
- Key contributors: @DukeOphir, @carsonroscoe7, @ilikesymmetry
