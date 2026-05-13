# ADR-0016: Sentinel API Specification

**Status:** Accepted
**Date:** 2026-05-13
**Decision Makers:** Raul Jäger (Founder)
**Related:** ADR-0012 (Sentinel Architecture), ADR-0013 (Payment Architecture), ADR-0015 (Tier Consolidation)

---

## Context

ThoughtProof Sentinel is a separate PLV product targeting agentic workflows where lightweight, high-volume verification checkpoints are needed. It operates on its own deployment (`sentinel.thoughtproof.ai`) with its own release cadence, telemetry, and future auth story.

This ADR specifies the API surface, route conventions, tier definitions, and auth model for the initial Sentinel release.

---

## Decision

### 1. Deployment

| Aspect | Decision |
|--------|----------|
| Repository | `ThoughtProof/thoughtproof-sentinel` (private) |
| Hosting | Vercel serverless |
| Domain | `sentinel.thoughtproof.ai` |
| Separation | Own repo, own Vercel project — no shared packages with v2 initially |

**Rationale for separation:**
- Clean telemetry/billing isolation
- Independent release cadence (Sentinel can ship weekly without touching Enterprise)
- Future public repo as "Reference Implementation" for agentic commerce
- Own x402 auth story possible (different pricing, different payment semantics)

### 2. Route Convention: Product-Namespaced

```
GET  /sentinel/health
GET  /sentinel/tiers
POST /sentinel/verify
```

**Convention:** `/sentinel/*` (product-namespaced), NOT `/v1/*`.

**Rationale:**
- `/v1/*` would be semantically confusing — "v1" is universally associated with `api.thoughtproof.ai` (PoT backend) across all docs, ADRs, and partner conversations
- Subdomain separates hosts technically, but humans and agents read route paths in isolation
- Self-documenting: seeing `/sentinel/verify` in logs/traces immediately identifies the product
- Future breaking changes: `/sentinel/v2/*` — clean, no namespace collision

### 3. Tier Configuration

| Tier | Price | Cascade | Accuracy | FA | Latency | Default |
|------|-------|---------|----------|-----|---------|---------|
| `checkpoint` | $0.003 | Nano solo | ~83.3% | 0* | 0.9s | No |
| `standard` | $0.005 | Nano→Pro | 81.3% | 0 | 1.3s | Yes |

*\*0 FA with asterisk on checkpoint: empirically 0 on current 170-case benchmark, but Nano solo without cascade rescue has theoretical FA risk on adversarial inputs.*

**Reserved:** `thorough` tier slot (Nano→Ultra, ~82.7%, 2.3s) — defined only when market demands it.

### 4. Modes

All 4 PLV modes available on Sentinel, same semantics:

| Mode | Purpose |
|------|---------|
| `handoff` | Inter-agent claim-packet coherence |
| `plan_revision` | Goal-drift detection at execution checkpoints |
| `memory_write` | Self-summary faithfulness before memory commit |
| `output_synthesis` | Final output quality vs. evidence chain |

### 5. Auth Model (Phased)

| Phase | Auth | Use Case |
|-------|------|----------|
| Phase 0 (AMA demo) | Open / no auth | Demo, testing, developer onboarding |
| Phase 1 (Production) | API Key (`X-Sentinel-Key` header) | Rate limiting, billing attribution |
| Phase 2 (Agentic) | x402/USDC (per ADR-0013) | Autonomous agent payment |

**Decision point:** Phase 0 → Phase 1 transition triggered by AMA date confirmation or first external caller, whichever comes first.

### 6. Request/Response Schema

**POST /sentinel/verify**

Request:
```json
{
  "claim": "string (required, max 100KB)",
  "evidence": "string (required, max 500KB)",
  "mode": "handoff | plan_revision | memory_write | output_synthesis",
  "tier": "checkpoint | standard (optional, default: standard)",
  "id": "string (optional, auto-generated)"
}
```

Response (200):
```json
{
  "id": "sent_abc123",
  "verdict": "ALLOW | BLOCK | UNCERTAIN",
  "confidence": 0.87,
  "reasoning": "...",
  "mode": "handoff",
  "tier": "standard",
  "meta": {
    "duration_ms": 1300,
    "models_used": ["nano", "pro"],
    "verified_at": "2026-05-13T17:00:00Z"
  }
}
```

Error (501 — engine not wired):
```json
{
  "error": "Sentinel engine not yet implemented",
  "code": "ENGINE_NOT_IMPLEMENTED",
  "hint": "Tier 'standard' (nano→pro) is configured but the verification engine is not yet wired.",
  "accepted_request": {
    "mode": "handoff",
    "tier": "standard",
    "cascade": ["nano", "pro"],
    "price_usd": 0.005
  }
}
```

### 7. Cascade-Billing Logic

Same pattern as Enterprise v2:
- `TierConfig` → engine execution → billing event emission
- Billing events are structured logs (JSON to stdout) in Phase 0
- Stripe meter integration deferred to separate sprint
- x402 integration deferred to ADR-0014 resolution

---

## Consequences

### Positive
- Clean separation from Enterprise API — independent velocity
- Product-namespaced routes eliminate v1/v2 confusion
- 501 stubs allow Vercel deployment + domain verification immediately
- Schema validation works end-to-end even without engine

### Negative
- Code duplication with v2 (types, validation patterns) — accepted short-term, shared package later when pain is real
- Two Vercel projects to manage

### Neutral
- No engine implementation in this ADR — that's a separate PR once ADR-0014 (cascade billing) is resolved

---

## Action Items

1. [x] Repo created (`ThoughtProof/thoughtproof-sentinel`)
2. [x] Stub routes implemented (health, tiers, verify)
3. [x] Tests passing (12/12)
4. [ ] Vercel project created + `sentinel.thoughtproof.ai` domain configured
5. [ ] ADR-0016 committed to sentinel repo
6. [ ] Engine wiring (post-AMA timing decision)
7. [ ] API Key auth middleware (Phase 1 trigger)

---

## References

- ADR-0012: Sentinel Architecture
- ADR-0013: Payment Architecture
- ADR-0015: Tier Consolidation
- Templates: `openserv-sentinel/templates/01-04`
