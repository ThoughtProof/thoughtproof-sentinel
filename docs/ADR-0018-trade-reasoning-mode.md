# ADR-0018: trade_reasoning Mode — Inferential Integrity over Evidence Grounding

**Status:** Proposed
**Date:** 2026-06-17
**Decision Makers:** Raul Jäger (Founder)
**Related:** ADR-0007 (Cross-Model Verification), ADR-0016 (Sentinel API Spec)
**Implements:** Fact-check + coherence three-layer split (CB4A workstream)

---

## Context

The CB4A A/B benchmark (verified vs. unverified trading agent on the Coinbase
stack) showed the verified arm returning **~98% UNCERTAIN** verdicts. Root-cause
analysis over 279 cycles isolated the driver:

- **82% of UNCERTAINs** trace to `step_2` ("no fabricated justifications") in
  the `trade_execution` mode. pot-cli returns `CONDITIONAL_ALLOW`, the
  conservative `trade_execution` remap turns it into `UNCERTAIN`, and the trade
  dies. In 62 cycles `step_2` was the *only* weak step.
- **18%** trace to cascade disagreement (`primary_hold`: serv-nano HOLD,
  serv-pro ALLOW → HOLD → UNCERTAIN) — these had the *highest* confidence
  (avg 0.85).
- Only **2%** were genuine BLOCKs.

The `step_2` criterion demands **evidence grounding**: "every justification must
reference data actually present in the evidence." But the evidence sent to
Sentinel is only the agent's own thesis + reasoning — there is no independent
ground truth. The verifier is asked to confirm "XLM is up 21.8%" against a
document that contains only the agent's *claim* of 21.8%. This is circular: the
agent is verified against itself, so the honest verdict is always "weakly
supported."

A prior experiment forwarded raw live market data into the Sentinel evidence to
fix this. It made results **worse**: the LLM found micro-discrepancies (agent
rounds to 21.8%, feed says 21.3%, briefs are minutes stale) and punished every
one as fabrication — conflating "could not verify" with "contradicts the data."

This is a **category error**. Without ground truth, the only verifiable property
is *faithfulness/consistency* (thesis ↔ reasoning), not *factuality*
(thesis ↔ market). A trading thesis is not a trace to be grounded — it is an
argument to be checked for internal coherence.

---

## Decision

### 1. Three-Layer Separation of Concerns

Fact-checking and coherence-checking are split across layers that each do one
job, instead of forcing the LLM to do both (which failed):

```
Layer 1 — Structural (deterministic, cb4a-verify)
  • Order facts vs. live market: min size, book depth, slippage, status
  • NEW: thesis fact-check (fail-toward-silence):
      - direction contradiction → HARD BLOCK (binary, unfixable)
      - magnitude / range deviation → VERIFIED-FACT FLAG → Sentinel evidence

Layer 2 — Sentinel trade_reasoning (LLM, this ADR)
  • Inferential integrity: does the thesis contradict its own reasoning?
  • Receives Layer-1 verified facts as ANCHORS, never parses raw data itself

Layer 3 — Verdict mapping (trade_reasoning)
  • step_0 / step_1 failure stays conservative (UNCERTAIN/BLOCK)
  • step_2-only CONDITIONAL_ALLOW → ALLOW (inferential pass ≠ block reason)
```

**Key insight:** when Layer 1 flags a soft deviation, it sends Sentinel a
*deterministically verified fact* ("structural_fact: 24h_change = +8.1%
(verified); thesis claims 21.8%"), not a raw market dump. Sentinel reasons
against an anchor instead of parsing — which is exactly what the failed
experiment got wrong.

### 2. New mode `trade_reasoning` (fork of `trade_execution`)

`trade_execution` is left **unchanged** (banking use-cases, backward compat).
`trade_reasoning` forks it with a rewritten `step_2`:

- **Old:** evidence grounding — "every claim must reference data in evidence"
- **New:** *inferential integrity* with claim-typing — a fabrication is (a) a
  claim that **contradicts** the reasoning, (b) a conclusion invoking factors
  **not mentioned** in the reasoning, or (c) a logical non-sequitur. Numerical
  rounding, derived metrics, interpretive judgments, and forward-looking claims
  are explicitly **NOT** fabrication.

Rationale for a separate mode over editing `trade_execution`: TrustBench data
(25-35% harm increase on out-of-domain plugins) supports domain-specific modes;
existing Sentinel consumers keep their validated behavior; clean A/B testability.

### 3. Fact-checker is fail-toward-silence

The structural layer is otherwise hard fail-closed. The thesis fact-checker is
the deliberate exception: it parses natural-language claims, which is fragile,
so it **only speaks on high-confidence extraction AND violation beyond a
generous tolerance**. On any parse ambiguity it stays silent and lets the trade
through. Sentinel's coherence check is the backstop. Better to pass an
unparseable fabricated number than to block a good trade over a rounding
artifact.

Tolerances (to be calibrated against point-in-time snapshots, not asserted):
- Direction contradiction: window trend decisively opposite, |trend| ≥ 3%
- Magnitude flag: claimed %-move differs from verified by > 10pp
- Range-position flag: claimed vs. verified > 15pp

---

## What this ADR deliberately does NOT do

- **Does not invert the cascade (ADR-0007).** A proposal to promote serv-nano
  HOLD to ALLOW when serv-pro agrees with conf ≥ 0.80 is held back. ADR-0007's
  "disagreement = caution" is validated; the confidence figure is only an avg
  step-score heuristic. Using a heuristic to override a cross-model safety check
  is a false-allow risk. → tested in isolation, not shipped with this change.
- **Does not re-assert "0 False Allows."** The looser mode changes the risk
  surface; the figure must be **re-measured** on `trade_reasoning` before reuse
  in any external material.
- **Does not drop fact-checking.** Earlier draft parked it ("nobody checks
  facts"). That gives up the fabricated-number threat — the core TP value prop.
  Fact-checking moves into the deterministic layer, it does not disappear.

---

## Product-language guardrail

"Inferential integrity" means **"the agent did not contradict itself."** It must
never drift to "the trade is sound." Thesis and reasoning come from the same
agent, so this check catches sloppiness, not generator error — that is real
value, but a *narrower* claim than what RV (Generator ≠ Verifier) provides.

---

## Research grounding (Paul + Computer, 2026-06-17)

> ⚠️ Citations below are reported by the research track and **not yet
> independently verified**. Verify arXiv IDs + authors + venue before any of
> these move into externally-visible material (whitepaper, sales sheet).

**Why the cascade-disagreement override (cut from Phase 1) stays cut.**
The pattern is real — "Trust or Escalate: LLM Judges with Provable Guarantees for
Human Agreement" (Jung et al., ICLR 2025) describes Cascaded Selective
Evaluation: a weaker judge first, escalate to a stronger one on low confidence.
BUT the provable guarantee P(judge agrees with human) ≥ 1−α holds **only with
thresholds calibrated against a labeled set** (simulated annotators + fixed
sequence testing). pot-cli's confidence is an uncalibrated avg step-score — never
validated against labels. "Gatekeeper: Improving Model Cascades Through
Confidence Tuning" (Rabanser et al., Google 2025) reinforces this: cascade
confidence override needs an explicitly fine-tuned confidence head; off-the-shelf
scores are insufficient. → ADR-0007 ("disagreement = caution") stands until we
have a labeled calibration set + a statistical guarantee. The override is not
forbidden — it is *unfunded* until that tooling exists.

**Name for the three-layer split: Neuro-Symbolic Verification.**
The deterministic fact-layer + LLM coherence-layer is the established
neuro-symbolic guardrail pattern: symbolic component does fact-checking / rule
validation / data reconciliation; neural component does reasoning / coherence.
Refs (to verify): "Bridging Symbolic Control and Neural Reasoning in LLM Agents"
(arXiv:2511.17673, "Symbolic Control Layer"); "AI Agent Systems: Architectures,
Applications, and Evaluation" (arXiv:2601.01743). Internal/whitepaper language:
**"Neuro-Symbolic Verification Split."** Sales/external language: **"deterministic
fact-checking + AI reasoning verification"** (no paper context needed).

---

## Validation plan (gates before live)

1. Log decision-time `marketSnapshot` into every CycleRecord (DONE 2026-06-17).
2. Build `trade_reasoning` + fact-checker (in progress).
3. After ~24-48h of snapshots: replay fact-checker point-in-time, **calibrate
   tolerances** against real data.
4. Stand up a `trade_reasoning` shadow arm parallel to existing arms.
5. Steel-man review + measured 0-False-Allow on the new mode → Raul OK → live.

## Consequences

- **Positive:** expected ALLOW-rate 40-60% (vs 0%); substantive objections for
  the replan loop instead of generic "data not supported"; honest,
  procurement-defensible product story.
- **Negative:** new mode to maintain; tolerances need empirical calibration;
  fact-checker is a natural-language parser (mitigated by fail-toward-silence).
- **Risk:** a coherent thesis on a fabricated number that the deterministic
  layer fails to parse passes through. Accepted: it is rare, and the alternative
  (strict grounding) is empirically worse.
