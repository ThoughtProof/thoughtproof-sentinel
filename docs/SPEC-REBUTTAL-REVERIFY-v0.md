# SPEC — Rebuttal / Reverify (protocol upgrade)

**Status:** DRAFT LOCK v0 · concept frozen · **no schema freeze · no impl · no public claim**  
**Date:** 2026-09-16  
**Type:** Upgrade of existing Sentinel verification protocol — **not a new product**  
**Owner:** ThoughtProof (Raul)  
**Related:** ADR-0016 (API) · ADR-0019 (action-auth) · CB4A `REVERIFY_AFTER_REPLAN` (client TOCTOU close, different) · `OUTBOX/2026-09-16-REBUTTAL-REVERIFY-NOTE.md`

---

## 0. One-line

False blocks are repairable with evidence, not negotiable with vibes.  
V1 BLOCK stays immutable; agent material only justifies a **new** verification V2 parent-linked to V1.

---

## 1. Problem

Today Sentinel returns BLOCK + structured objections. The agent can stop or change plan and call verify again (CB4A/VTA replan). What is missing at **protocol** level:

1. No first-class link from V2 back to the BLOCK that triggered repair  
2. No distinction: action repair vs evidence repair vs claim repair vs same-action false-block recovery  
3. No formal inbound channel answering specific objections with **prüfbare** state/reference changes  
4. Agent cannot “defend” a false BLOCK without either changing the action ad hoc or looking like negotiation

**Consequence:** fail-closed is correct but operationally harsh; false-block recoverability is unmeasured; decision models get objections but not a stable repair contract.

---

## 2. Non-goals (hard)

| Non-goal | Why |
|---|---|
| Override / mute V1 | Attestation integrity |
| Authority symmetry agent ↔ verifier | TP stays independent verifier |
| Appeal / vibes / “disagree louder → ALLOW” | Coach/dispute product drift |
| New product brand | This is Sentinel protocol upgrade |
| Schema freeze in v0 | Design lock first; schema later GO |
| Merge with Provenance/#8 or cumulative scope/#5 | Keep candidates separate |
| Public “we almost have this” claim | Honesty |

---

## 3. Core lock (Raul 2026-09-16)

- **Symmetry of claim contestability**, not symmetry of authority  
- V1 BLOCK = finished attestation · immutable · agent cannot “win” V1  
- Agent may only supply material that justifies **V2**  
- V2 evaluates a **new verification state** (Proposal + prior evidence + repair material)  
- Not: “Sentinel reconsiders its own decision”

```
V1: Proposal A + E1
      → Sentinel → BLOCK + Objection O1
            │ parent
            ▼
      Rebuttal: why O1 may no longer hold
               + E2 / claim revision / binding correction
            │
            ▼
V2: NEW verification (A + E1 + E2 …)
      → ALLOW | BLOCK | UNCERTAIN
```

---

## 4. Relationship to existing behavior

| Layer | What exists | What Rebuttal/Reverify adds |
|---|---|---|
| Sentinel outbound | structured `objections[]` | unchanged foundation |
| CB4A/VTA | replan after BLOCK; optional second verify | client pattern proving demand |
| CB4A `REVERIFY_AFTER_REPLAN` | TOCTOU close: verify revised plan before exec | **different** — still client; not parent-linked rebuttal of O1 |
| Ops merge gates | BLOCK → revise claim → new verify | informal ancestor of claim repair |
| **This spec** | — | protocol parent link + repair classes + recoverability metrics |

**One sentence:** Replan = agent behavior. Rebuttal/Reverify = protocol + measurability of the same idea.

---

## 5. Repair classes (direction only — not schema)

Inbound rebuttal must map to a **prüfbare Zustands- oder Referenzänderung**:

| Class | Meaning |
|---|---|
| `new_evidence` | Missing evidence class now attached |
| `claim_revision` | Claim narrowed/corrected (not free essay) |
| `binding_correction` | Amount/recipient/kind/id binding fix |
| `stale_source` / `wrong_source_reference` | Source/time reference fix |
| *(open)* | Further classes only if objectively checkable |

**Insufficient alone:** `disagree_with_objection`, free-form argument, “trust me”.

**Policy disagreement** → not auto-ALLOW; stays BLOCK/REVIEW or human path.

---

## 6. Outcome taxonomy (metrics target)

After V1 BLOCK → rebuttal → V2:

| Path | Label |
|---|---|
| Agent changes **ACTION** → ALLOW | `action_repair` |
| Supplies missing **EVIDENCE**, same action → ALLOW | `evidence_repair` |
| **CLAIM** clarify/correct, same action → ALLOW | `claim_repair` |
| Rebuttal changes nothing material → BLOCK | `objection_sustained` |
| Valid rebuttal, **same action**, ALLOW where V1 was false BLOCK | `false_block_recovered` |

**New product metric (later):** False-Block Recoverability  
= share of verifier-side false blocks that become ALLOW on same action via evidence/claim repair.

Operational read: 1% false-block rate with 95% auto-recoverable ≠ 1% that kills the run.

---

## 7. Invariants

1. V1 never mutated or deleted  
2. V2 always new `verificationId`  
3. V2 carries `parentVerificationId` (or equivalent) when it is a rebuttal path  
4. Cap rebuttal depth (e.g. 1–2) per action lineage — no ping-pong  
5. Same gate semantics on V2 (fail-closed; no soft override)  
6. Decision-model lane (Sage/Jev/agent) ≠ verifier lane (TP)  
7. Effect map unchanged: RECOMMEND / DO_NOT_RECOMMEND / REVIEW_REQUIRED; DO_NOT_RECOMMEND ≠ wallet deny  

---

## 8. Framing (public / BD)

**Do say:** Protocol upgrade. Repairable false blocks. Structured objections as interface between decision model and verifier.  

**Don’t say:** Agents can fight the gate. Appeal court. Coach. New product. Sage-inside-TP.

---

## 9. Open design questions (pre-schema)

1. Parent field name + how multi-objection rebuttals bind (`addressesObjection[]`)  
2. Same-action identity: hash of what? (calldata / intent / canonical proposal)  
3. Interaction with signed export / M2 subject (parent export vs child export)  
4. Cap + rate-limit policy  
5. How CB4A replan logs migrate to repair classes without rewriting history  
6. Relationship to action-auth REVISE_CLAIM receipts  
7. Whether UNCERTAIN V1 can enter the same path  

---

## 10. Acceptance for “spec done enough to schedule eng”

- [x] Problem / non-goals / lock written  
- [x] Distinct from CB4A replan and REVERIFY_AFTER_REPLAN  
- [x] Repair classes + metric intent named  
- [ ] Schema v0.1 (only on explicit Raul GO)  
- [ ] Fixture pack (false-block recovered vs action repair)  
- [ ] ADR number assigned + linked from ADR-0016  

---

## 11. Decision

**LOCK as upgrade candidate.**  
Next: roadmap phases. Impl only after explicit GO and after higher-priority live gates allow.
