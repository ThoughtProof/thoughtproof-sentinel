# ADR-0019 Addendum — Cascade Promotion Invariant (2026-08-08)

**Status:** Accepted  
**Date:** 2026-08-08  
**Parent:** ADR-0019 (action_authorization mode)  
**Decision makers:** Raul Jäger (Founder), via postmortem review  
**Evidence:** E-4 Full80 post-deploy FA postmortem  
`docs/experiments/e4-external-v0.2/product_run/out/post_deploy_full80/FA_POSTMORTEM.md`

---

## Context

Full80 post-deploy (confirmBlocks ON experiment snapshot) produced public ALLOWs
on gold BLOCKs where:

1. Model drift flipped step scores (first divergent stage = **model**).
2. Policy mapping (cascade reason + ADR-0019 all-steps-pass promotion) amplified
   that into a **safety leak** (public ALLOW).

Notably S-IM-003 post path:

- cascade reason `primary_block_rejected` (primary=BLOCK, secondary=ALLOW)
- cascade internal verdict = HOLD
- mapVerdict → UNCERTAIN
- `canPromoteAllStepsPass` → **public ALLOW**

S-HG-009 / S-UI-001 reached public ALLOW via `agreement_conditional_allow` +
all-steps-pass promotion, independent of `primary_block_rejected`.

**Finding:** Model drift creates the deviation; policy mapping turns it into a
safety leak.

---

## Decision

### 1. Hard invariant — no promote on `primary_block_rejected`

**Nein:** `primary_block_rejected` darf grundsätzlich **nicht** zu ALLOW
promotet werden.

```
primary = BLOCK
secondary ∈ {ALLOW, CONDITIONAL_ALLOW}
→ cascade internal = HOLD
→ public = REVIEW   # never ALLOW via ADR-0019 all-steps-pass
```

### 2. Narrow exception (machine-checkable only)

Promotion from a primary BLOCK path is allowed **only if**:

- the primary BLOCK is exclusively about an **explicit, machine-checkable
  authorization condition**, and
- fulfillment of that condition is **cryptographically bound** to exactly this
  action, and
- action-auth does **not** override semantic conflicts with resilience,
  mandate alignment, or evidence.

This exception is for deterministic gate / crypto-bound authority clearance —
**not** for LLM step scores looking clean after a cascade disagreement.

### 3. `agreement_conditional_allow` default

```
agreement_conditional_allow
→ public REVIEW by default
→ ALLOW only after machine fulfillment of all conditions
```

Affects S-HG-009 and S-UI-001 class independently of `primary_block_rejected`.

### 4. Causal language

`deploy_reg` / “deploy regression” means **post-deploy observed regression**,
not proven deployment root cause. With identical request hash and first
divergence in the model, model stochasticity or provider drift may apply.
Cascade + ADR-0019 remain the **amplifiers** to public ALLOW.

---

## Consequences

**Must change (implementation — after flip-rate measurement, not before):**

1. Engine 3c (`canPromoteAllStepsPass`) must **not** fire when cascade reason is
   `primary_block_rejected` (and likely other primary-BLOCK disagreement
   reasons).
2. Default public mapping for `agreement_conditional_allow` becomes REVIEW
   unless machine conditions are fulfilled.
3. Regression tests for the four FA cases + 002/012 promotion path.

**Must not change yet:**

- confirmBlocks stays **OFF** in production.
- Frozen Full80 labels / sealed_gold unchanged.
- No prompt tuning during measurement.

---

## Implementation gate (ordered)

1. ~~This decision written~~  
2. ~~Replay four FA cases N times unchanged; measure flip rates~~  
3. ~~Sample twelve BLOCK→REVIEW exact losses~~  
4. ~~Policy code + regression tests (local)~~  
5. Deploy — **not done**; requires explicit go after review  

---

## Implementation status (local, 2026-08-08 evening)

**NOT deployed.**

- Engine helper: `resolveActionAuthPromotion` in `src/engine/verdict.ts`
- Wired in Sentinel promotion layer only (`src/engine/index.ts`) — cascade untouched
- Trace on `meta.promotion`: cascade_reason, internal_verdict, mapped_verdict, public_verdict
- Exception / machine condition-proof: **fail-closed** (`acceptsMachineConditionProof` always false)
- `agreement_allow` unchanged (003/005 separate semantic track)
- DQL: untouched
- Tests: `action_auth_promotion.test.ts` + verdict/engine/cascade/trade_reasoning — **68 green**
- Flip replay note: **0 observed flips in 20 runs** (not a proof of zero stochasticity)

---

## Non-goals

- Claiming model drift is “caused by” confirmBlocks alone  
- Opening sealed_gold  
- Broad prompt rewrites before flip-rate data  
- Claiming 0/20 flips proves no stochasticity  

