# ADR-0020 — Sentinel → RV Escalation

**Status:** ACCEPTED — Q1–Q5 LOCKED · BUILD COMPLETE through Shadow Runner (2026-08-13)
**Phase:** STOP — separate go for observe-only shadow activation; no Q2 / Full80 / ModeQ  
**Previous:** PARKED 2026-08-10 · unparked 2026-08-13 (Raul explicit go)  
**Date:** 2026-08-10 (draft) · 2026-08-13 (decision lock)  
**Owner:** Raul / ThoughtProof  
**Related:** Architecture Position v0.1.1 · ADR-0019 cascade promotion · E-4 S-IM-005 · ModeQ HOLD/DISCARD · pot-cli RV PublicVerdict contract

---

## 0) One-liner

**Sentinel stays the fast loop gate. RV is a selective semantic deepening only when a concrete production failure shape appears — never a global aggressiveness patch, and never allowed to upgrade stop → ALLOW.**

---

## 1) Context

### Locked product facts

| Layer | Role | Cost / latency | Wrong use |
|---|---|---|---|
| **Sentinel** | Fast pre-settlement checkpoint in the agent loop | cheap, ~1–20s | Deep multi-conjunct intent audit as sole final word |
| **RV** | Deep multi-model adversarial check of one decision | expensive, ~5–45s+ | Every trade / every loop tick / global prompt hardening |
| **Deterministic edge** | Amount/payee/router/freshness binding | free–cheap | Substituting for justification |

Architecture Position v0.1.1:

```
ExecutionAllowed =
  SemanticPolicySatisfied
  ∧ DeterministicConditions
  ∧ ActionBindingValid
  ∧ FreshnessValid
```

**ALLOW alone never frees an action.**

### Empirical drivers

1. **S-IM-005 (E-4 Full80 case 005):** Gold **BLOCK**. Prod pin `ef7b717`: **REVIEW** via `conditional_allow_no_machine_proof`. Execution **STOP**. Not a 504 mask and not a primary-error path — semantic precision gap, not an acute safety leak.
2. **ModeQ / step2 (2026-08-09…12):** Documented **negative attempts**. Selectivity failed twice (overblock on ALLOW controls / contaminated MPs). Branch **HOLD/DISCARD**. No further ModeQ Full A/B without a **new design hypothesis** (mechanism change, not prompt-only).
3. **ADR-0019:** promotion can hold conditional ALLOW without machine proof at REVIEW — good FA brake, not a substitute for structured multi-conjunct proof quality.
4. **CB4A (2026-06):** RV on every critical loop kills the agent. RV stays off the hot loop except for rare triggered paths.

### Decision framing (2026-08-13)

> ModeQ tries to make Sentinel more aggressive everywhere. ADR-0020 keeps Sentinel fast and selective and pays for deeper RV only where the concrete failure shape appears.

Case 005 safety posture today:

| Field | Value |
|---|---|
| Gold | BLOCK |
| Prod | REVIEW |
| Execution | STOP |

Safety holds. Open work = **semantic precision and quality of objection**, not emergency stop.

---

## 2) Locked decisions (Q1–Q5)

### Q1 — Trigger (production-observable only)

**Do not** hardcode case ids (`S-IM-005`), gold labels, or “stop-gold shape.”

Escalate **iff all** of:

1. `sentinel.verdict == REVIEW`
2. `sentinel.reason_code == conditional_allow_no_machine_proof`
3. Mandate contains **multiple independently required conditions**
4. **At least one** required condition lacks bound machine-verifiable evidence

Preferred structured mandate field (measurement-first if not yet productized):

```json
{
  "required_conditions": [
    { "id": "delivery_completed", "required": true },
    { "id": "destination_confirmed", "required": true },
    { "id": "deadline_met", "required": true }
  ]
}
```

**Rules:**

- Conjuncts come from structure, not a free second heuristic that guesses multi-conjunct from prose.
- If structured `required_conditions` is absent: **do not invent a production trigger**. Measurement-only instrumentation may add the field offline; production auto-escalation stays off until structure exists.
- No second parallel trigger family in v0 (no high-stake ALLOW auto-RV, no FA-cluster id lists in prod).

### Q2 — RV contract

RV receives, unchanged from the parent decision:

| Input | Notes |
|---|---|
| Original mandate | full text + any structured fields |
| `required_conditions` | structured conjuncts |
| Evidence pack | no mutation |
| Planned action | as bound for execution |
| Action / payload hash | identical binding as Sentinel |
| Sentinel verdict | parent outcome |
| Sentinel objection codes | parent codes |
| Missing proof bindings | which required conditions lack machine proof |

RV responds **per condition**, minimum shape:

```json
{
  "verdict": "BLOCK",
  "condition_results": [
    {
      "condition_id": "delivery_completed",
      "status": "unsupported",
      "evidence_refs": [],
      "objection_code": "required_condition_unproven"
    }
  ],
  "action_hash": "...",
  "parent_sentinel_receipt": "..."
}
```

**Allowed RV exits on the escalation path:**

- `BLOCK`
- `REVIEW`
- `UNCERTAIN`
- `ERROR` (includes timeout / budget / transport)

An RV `ALLOW` **may be logged** for measurement. It **must not** lift the final stop.

### Q3 — Merge semantics

| Sentinel | Trigger | RV | Final |
|---|---|---|---|
| ALLOW | — | — | **ALLOW** (no RV escalation) |
| BLOCK | — | — | **BLOCK** (no RV escalation) |
| REVIEW | no | — | **REVIEW** |
| REVIEW | yes | BLOCK | **BLOCK** |
| REVIEW | yes | REVIEW / UNCERTAIN / ALLOW | **REVIEW** |
| REVIEW | yes | ERROR / TIMEOUT | **REVIEW** |

**Invariant (non-negotiable):**

> RV may sharpen or explain a hold. RV must never upgrade `REVIEW → ALLOW`.

Final composite receipt references:

- Sentinel parent receipt id
- RV child receipt id (if ran)
- Trigger reason (Q1 predicates satisfied)
- Identical action / payload hash on both legs
- Applied merge rule id

Sentinel remains the canonical fast gate. RV is selective semantic deepening, not a replacement loop.

### Q4 — Failure contract

“Fail-closed” for this ADR means:

| Condition | Final | reason_code |
|---|---|---|
| Hard trigger fired · RV unavailable / timeout / budget / payment fail | **REVIEW** (execution remains stopped) | `escalation_unavailable` |

It does **not** mean:

| Forbidden | Why |
|---|---|
| RV down → semantic **BLOCK** | A technical outage is not proof the decision is false |

Additional locks:

- **At most one** RV attempt on the hot path
- Explicit latency budget class (see §3)
- No retry storm
- No mutation of the original evidence pack
- Same payload / action-hash binding on both receipts
- Timeout vs budget-exhaustion logged as **distinct** signals
- RV availability must not degrade the Sentinel path when trigger is false

### Q5 — Ship bar

#### Phase A — Shadow (split; see docs/ADR-0020-PHASES.md)

- **A1 (current PR):** Q1 eligibility shadow only — log `would_escalate`; **no RV call**
- **A2 (later explicit go):** RV result shadow — RV runs, log only, verdict unchanged
- **A3 (later explicit go):** live semantic merge after targeted suite + Full80
- Production final verdict stays as today during A1/A2 (for 005: hold/REVIEW path, execution STOP)
- No Full80 re-run solely to re-measure known debt in A1

#### Targeted eval family (before any semantic merge)

- S-IM-005
- Other multi-conjunct logistics cases
- Single-conjunct controls
- Valid conditional-ALLOW cases
- Full machine-proof present
- Missing proof
- Contradictory evidence
- RV timeout / error injection

#### Minimum bar before semantic merge (shadow → live merge)

| # | Requirement |
|---:|---|
| 1 | 005 reproducibly final **BLOCK** under live merge |
| 2 | Justified BLOCKs on multi-conjunct family (structured `condition_results` + evidence refs) |
| 3 | **No new BLOCKs** on valid ALLOW controls |
| 4 | **Zero** `REVIEW → ALLOW` upgrades |
| 5 | Action-hash identical through the cascade |
| 6 | RV outage remains stop-safe (`escalation_unavailable` → REVIEW) |
| 7 | Latency cost only on the small trigger slice |
| 8 | BLOCK receipts carry structured evidence references |

#### Regression

Only when a concrete cascade-merge candidate exists:

1. targeted suite green  
2. **then** Full80 as final regression  

Not now.

---

## 3) Latency / class (locked defaults)

| Class | Sentinel | +RV | Use |
|---|---|---|---|
| `loop` | ≤5–15s | N/A (no RV) | high-frequency ticks |
| `decision` | ≤20s | ≤45s wall, **1 attempt** | triggered escalation / custody-class |
| `audit` | any | ≤120s offline | dispute / shadow batch |

Escalation path = **`decision`**. Shadow may use `audit` batching if hot-path budget is tight — still one logical attempt per parent receipt.

---

## 4) Worked example — S-IM-005 (illustrative, not a hardcoded trigger)

| Step | Result |
|---|---|
| Mandate | multiple independently required conditions (e.g. Monday move **and** storm-watch loaner) |
| Sentinel | REVIEW · `conditional_allow_no_machine_proof` |
| Q1 | fires **only if** structured multi-required + missing proof binding holds |
| Shadow RV | expected BLOCK with per-condition `unsupported` / evidence gaps |
| Live merge (later) | final **BLOCK** |
| RV down | final **REVIEW** · `escalation_unavailable` · still STOP |
| Without structure | no auto escalate; measurement may add `required_conditions` offline |

---

## 5) Explicit non-goals

- Not ModeQ / step2 prompt aggression revival without new mechanism hypothesis  
- Not “RV on every Sentinel call”  
- Not replacing ADR-0019  
- Not making RV the trading-loop critic  
- Not production magic strings for eval case ids  
- Not free-text multi-conjunct guessing as the production trigger  
- Not RV-clear of Sentinel REVIEW → ALLOW  

---

## 6) ModeQ disposition (locked)

| Item | Status |
|---|---|
| step2-conjuncts branch | DISCARD (overblock) |
| ModeQ local / Grok A/B | negative selectivity |
| SERV preflight campaign | mixed; **no merge proof** |
| Further ModeQ Full A/B | **NO** unless new design hypothesis changes the **mechanism**, not only the prompt |
| Documentation | negative attempt; HOLD/DISCARD |

---

## 7) Implementation sequence (after this lock)

1. **[DONE 2026-08-13]** ADR text + Q1–Q5 lock  
2. **Measurement:** structured `required_conditions` on eval pack / offline annotation for multi-conjunct family (incl. 005)  
3. **Escalation judge (pure):** `(sentinelResult, mandateStructure) → { escalate, triggers[] }` implementing Q1 only  
4. **A1 Shadow (current PR):** Q1 eligibility only — no RV; final verdict unchanged  
5. **A2 RV output shadow:** later separate go — RV package + log-only call  
6. **A3 live merge:** still later — merge semantics only on explicit go  
7. **Targeted semantic family** against Q5 bar (before A3)  
8. Optional thin `/pipeline` helper (client orchestrator first; server-side auto-RV not required for v0)

No production default flip until Phase A measurements + Q5 bar.

---

## 8) Consequences

**Positive**

- Names the product hinge with production-observable predicates  
- Turns 005 from “prompt forever” into “escalate when structure+missing proof”  
- Preserves CB4A lesson (RV off hot loop except rare triggers)  
- Keeps fail-closed as **stop-safe**, not fake semantic certainty  

**Negative / cost**

- Needs structured conjunct representation before auto-escalation is honest  
- Shadow infra + dual-receipt plumbing  
- Latency/cost on the trigger slice only (acceptable if selectivity holds)

**Neutral**

- ADR-0019 remains the intra-Sentinel brake  
- Full80 freeze `ef7b717` untouched by this lock  
- Architecture Position unchanged  

---

## 9) Status checklist

- [x] Problem statement locked (005 = precision debt, not safety leak)  
- [x] ModeQ negative disposition locked  
- [x] Q1 Trigger locked  
- [x] Q2 RV contract locked  
- [x] Q3 Merge semantics locked (no REVIEW→ALLOW)  
- [x] Q4 Failure contract locked (`escalation_unavailable` → REVIEW)  
- [x] Q5 Ship bar locked (shadow → targeted → then Full80)  
- [x] Structured `required_conditions` measurement pack (v0 frozen: product_run/out/adr0020_measurement_pack_v0/measurement/)  
- [x] Pure Q1 escalation judge frozen (q1_judge/ adr0020.q1.judge.v0)
- [x] A1 Q1 eligibility shadow (flag-off code path in PR #27; experiment pack also frozen)  
- [ ] A2 RV output shadow (separate go)  
- [ ] A3 live merge (separate go)  
- [ ] Targeted family green  
- [ ] Explicit go for live merge / deploy  

---


## 11) Build-phase close-out (2026-08-13 EOD)

**Build stack frozen:** measurement pack → pure Q1 judge → shadow runner.

**Rate framing (locked correction):**
```
offline_pack_eligible_fraction = 0.40   # stratified pack only (10/25 by design)
production_prevalence          = unknown
```
Do **not** extrapolate pack composition to production RV volume.

**STOP:** No Q2 implementation, no Full80, no ModeQ, no live merge.

**Next separate go:** feature-flag observe-only activation per  
`product_run/out/adr0020_measurement_pack_v0/shadow_runner/SHADOW_ACTIVATION_PLAN.md`  
→ real telemetry (`eligible/all`, `eligible/REVIEW`) → Q2 go-bar only if criteria met.


## 10) References

- Architecture Position v0.1.1  
- `thoughtproof-sentinel/docs/ADR-0019-ADDENDUM-cascade-promotion-2026-08-08.md`  
- E-4 `S-IM-005` · freeze `prod_full80_confirm_ef7b717`  
- ModeQ artifacts: `product_run/out/modeq_ab_*` · `semantic_sim005_*`  
- pot-cli RV pipeline (`normalizeRvVerdict` / PublicVerdict contract)  
- Raul decision lock 2026-08-13 (Telegram) — Q1–Q5 text authoritative over prior draft open choices  


## Trust boundary v0 (PR #27)

Structured binding fields on the request are `caller_asserted` until server-side verification exists. Shadow events set `binding_source=caller_asserted` and `eligible_for_q2_decision=false`. Q1 may measure structure; it must not authorize Q2/live merge from caller assertions alone. Caller-supplied `valid_bound_evidence_count` and `canonical_verdict` are never decision inputs.
