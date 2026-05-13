# Sentinel Engine Architecture — Platform-Agnostic Design

**Status:** Directive (pre-implementation)
**Date:** 2026-05-13
**Author:** Raul Jäger

## Structure

```
src/
├── engine/                    ← Pure verification logic, no auth, no transport
│   ├── cascade.ts             ← Nano→Pro cascade (standard), Nano-solo (checkpoint)
│   ├── modes/
│   │   ├── handoff.ts
│   │   ├── plan_revision.ts
│   │   ├── memory_write.ts
│   │   └── output_synthesis.ts
│   └── verdict.ts             ← ALLOW/HOLD/UNCERTAIN/BLOCK logic
├── adapters/
│   ├── openserv.ts            ← OpenServ auth, webhook signatures, X-Sentinel-Key
│   └── (acp.ts later)         ← Virtuals/ACP adapter — job lifecycle, USDC pricing
├── api/sentinel/              ← Vercel routes — thin wrappers over Engine + Adapter
└── types.ts                   ← Platform-neutral VerificationRequest/Response
```

## Boundary Rule

> If it would look different under a different transport (gRPC) or platform (ACP vs OpenServ) → **Adapter**.
> Otherwise → **Engine**.

## Invariants

1. `VerificationRequest` and `VerificationResponse` are platform-neutral — no `openserv_*` or `acp_*` prefixes. Adapters map to/from wire format.
2. Mode handlers (`handoff.ts`, `plan_revision.ts`, ...) never import from `adapters/`. Strictly unidirectional: Routes → Adapter → Engine, never backwards.
3. Engine tests run without HTTP server, without auth mocks — pure input/output.

## Anti-Patterns

- ❌ Auth logic in engine code
- ❌ Platform-specific field names in VerificationRequest
- ❌ Webhook signature verification in mode handlers

## Rationale

- Engine purity enables unit testing without infrastructure mocks.
- Adapter pattern makes new platform support 1-2 days, not 1-2 weeks.
- Routes stay thin — parse, authenticate (via adapter), verify (via engine), respond.

## Adapter Architecture

Adapters split into two orthogonal axes — see **ADR-0017** for the full decision:

```
adapters/
├── platform/    ← WHO calls Sentinel (auth, lifecycle, webhooks)
│   ├── openserv.ts
│   └── acp.ts
└── payment/     ← HOW they pay (settlement, billing, metering)
    ├── x402.ts
    └── stripe.ts
```

Any platform adapter composes with any payment adapter. The engine never sees either.

## Related

- ADR-0016: Sentinel API Spec
- ADR-0017: Payment Adapter Layer
