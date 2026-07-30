# D1 — Veridex vs ThoughtProof boundary (GOAT)
**Date:** 2026-07-30  
**Status:** Working · use in Stephen reply + one-pager  
**Sources:** Stephen TG; GOAT Veridex article framing; Veridex self-desc (authorization / policy / no LLM on money path); EIP-8004 (identity / reputation / validation; payments orthogonal)

---

## One-liner (Stephen)

> Same abstract — “does this stay inside what the user allowed?”  
> **Veridex** enforces **spend/sign authority** (deterministic bounds).  
> **ThoughtProof** validates **decision quality** (mandate + evidence + replan) and emits a **portable validation receipt** on the ERC-8004 identity.  
> Wallet/payment middleware stays swappable — GOAT-agnostic.

---

## Matrix

| Axis | Veridex (authz lane) | ThoughtProof (decision lane) |
|---|---|---|
| Core question | May this agent **pay/sign** under bounded authority? | Is **this decision** justified by mandate + current evidence? |
| Timing | At/near payment / authorization path | **Before** a sign/pay request is formed; replan first |
| Mechanism | Deterministic policies: limits, counterparties, approvals, audit evidence | Semantic + structured objections; multi-model cascade; optional det. mandate gate |
| LLM on money path | **No** (explicit product claim) | Models may run in **verify**; they do not hold keys or settle |
| Inputs | Policy config + tx/payment intent fields | Mandate + proposed action + evidence pack + reasoning |
| Outputs | Allow / escalate / deny spend | ALLOW / BLOCK / UNCERTAIN + objections → agent replan |
| Failure class | Out of policy spend | In-policy tx that is still unjustified (stale evidence, mandate drift, unsupported claims) |
| ERC-8004 | Identity + authz/evidence bundles | Identity + **Validation-shaped** per-decision record (not reputation score) |
| GOAT fit | Authorization layer for agent payments (Grant narrative) | Behaviour guardrail + validation receipt (first-grant / reasoning verify narrative) |

---

## Overlap (mark honestly)

| Check | Owner |
|---|---|
| Max USDC per tx, allowlisted router, function selector | **Veridex / wallet policy** |
| Cumulative daily spend | **Veridex / wallet policy** |
| Quote age / portfolio DD **if** bound as authenticated fields into the wallet request and enforced there | **Overlap** — do not double-sell as TP-only |
| Thesis supported by evidence; claim consistency; replan loop | **ThoughtProof** |
| “Trusted” reputation/KYA vs this action | **ThoughtProof** (Dackie: score ≠ authorize) |

---

## Kill-switch

If a proposed TP check is **fully** expressible as Veridex/Privy deterministic policy on the payment request → **drop it from the TP pitch** and keep only decision/evidence/replan.

---

## Stack (wallet-agnostic)

```
ERC-8004 Agent
  → (optional) read trust surface (e.g. Intuition)
  → propose action + evidence
  → ThoughtProof decision validation ──OBJECT→ replan / stand down
  → ALLOW
  → Veridex (or other) spend authorization   // if present
  → wallet / settle (Privy, OKX, … — not GOAT-locked)
  → Validation receipt on 8004 identity
```

**Defense in depth** matches GOAT public framing: reasoning verify ≠ spend authorize.

---

## Related

- Boundary case (Privy ALLOW / TP OBJECT): `GOAT-BOUNDARY-CASE-PRIVY-VS-TP-v0-2026-07-30.md`  
- Plan: `PLAN-A-GOAT-INTUITION-TWO-FLY-2026-07-30.md`  
- Validation receipt v0: `ERC8004-VALIDATION-RECEIPT-v0-2026-07-30.md`  
