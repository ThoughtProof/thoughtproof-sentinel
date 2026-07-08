# Sentinel Verdict Non-Determinism — Root-Cause Analysis & Backend Ticket

**Date:** 2026-07-08
**Severity:** High (affects every gated decision; can flip a real trade BLOCK↔UNCERTAIN)
**Status:** Root cause isolated empirically. Runner-side mitigation shipped (SOFT_BLOCK_REPLAN, default OFF). Backend fix pending.

---

## TL;DR

The Sentinel verdict for **byte-identical input** is non-deterministic. Live-measured:
the same trade decision flips `UNCERTAIN ↔ BLOCK` across repeated `/sentinel/verify`
calls. Root cause is **NOT** LLM sampling and **NOT** the hosted provider — both
serv-nano and serv-swift return byte-stable verdict+confidence in isolation. The
variance is injected in the **per-gold-step grading stage** (`graded-support-evaluator`),
where the SAME 3 steps get scored completely differently run-to-run
(confidence 0.917 / 0 failing steps → 0.25 / 2 failing steps), flipping the aggregate
verdict.

---

## Evidence chain (each step measured, not assumed)

### 1. End-to-end verdict is unstable — LIVE
`/sentinel/verify`, mode=trade_execution, tier=standard, identical body, 5+ runs
(case = cb4a cycle 627, HYPE-USDC):

| run | verdict | confidence | objections | failing-steps |
|----:|---------|-----------:|-----------:|--------------:|
| 1–4 | UNCERTAIN | 0.917 | 3 | 0 |
| 5   | **BLOCK** | **0.25** | 3 | **2** |

Objection COUNT is stable (always 3). What changes is the **per-step score/predicate**:
the same steps are judged SUPPORTED in some runs and UNSUPPORTED in others.

### 2. Neither cascade model is the culprit — DIRECT PROVIDER TEST
Direct calls to openserv.ai, temperature=0, seed=42, same borderline prompt, 5 runs each:

| model | verdict (5×) | confidence (5×) |
|-------|--------------|-----------------|
| serv-nano | CONDITIONAL_ALLOW (stable) | 0.62 (stable) |
| serv-swift | CONDITIONAL_ALLOW (stable) | 0.72 (stable) |

Both models' **structured** verdict+confidence are byte-stable. (Only the free-text
`reason` prose drifts — irrelevant to the gate.) So the hosted provider DOES behave
deterministically for the structured judgement. The earlier "provider ignores seed"
hypothesis is **wrong** for the fields that matter.

### 3. Therefore the variance is in the grading/aggregation layer
Code path (thoughtproof-sentinel):
- `api/sentinel/verify.ts:90` → `src/engine/index.ts:101` `runSentinelCascade`
- verdict + confidence derived from `cascadeOutput.result.step_evaluations`
  (`index.ts:108`, `144–147`) — the **per-step scores**
- objections = one per step (`index.ts:159`), count stable
- the per-step SUPPORTED/UNSUPPORTED grading comes from pot-cli
  `graded-support-evaluator` — **this is where identical input yields different
  per-step scores between runs.**

`EvalOptions` at `src/engine/cascade.ts:46-49` is built as `{mode, maxTokens: 4096}`
— it does not (cannot, per the pot-cli interface) pass temperature/seed down to the
grader. But note: seed pass-through would NOT fix this anyway, because the provider
already returns stable structured output when called directly (see §2). The
instability is in how the grader elicits/parses the per-step judgement, not in a
missing seed.

---

## What does NOT fix it (empirically ruled out)
- ❌ Passing temperature/seed through cascade.ts EvalOptions — provider is already
  stable on structured fields; the drift is in the grader stage.
- ❌ Switching the hosted provider — direct calls are deterministic.

## What WILL fix it
1. **Best-of-N on the per-step grading** (server-side): grade each gold step N times,
   take the majority SUPPORTED/UNSUPPORTED. Kills the flip regardless of grader
   noise. Cost: N× grader calls on the verdict path. **Effort: MITTEL.**
2. **Stabilise the grader elicitation**: have the grader return a strict structured
   per-step verdict (it already can — see §2 stability) instead of a score that is
   re-derived/parsed from prose, and pin its decoding. **Effort: KLEIN–MITTEL**,
   entirely inside pot-cli graded-support-evaluator.
3. **Hysteresis at the CONDITIONAL_ALLOW→UNCERTAIN boundary** (`verdict.ts:104`):
   require a margin, not a single crossing. Reduces flips but doesn't remove the
   underlying grading variance. **Effort: KLEIN.** Palliative, not a cure.

**Recommended:** (2) as the real fix, (1) as a robust fallback if grader noise
can't be fully pinned.

## Runner-side mitigation already shipped
`SOFT_BLOCK_REPLAN=1` (cb4a-verify runner.ts, env-gated, default OFF): a noisy
3+-objection BLOCK is routed into the existing Re-Plan Loop instead of a hard
stood-down. Currently under paper validation on cb4a-std-disciplined. This is a
symptom-level buffer; the durable fix is backend (2) above.

## Reproduction
```
cd thoughtproof-sentinel
set -a; source ../verified-trading-agent/.env; set +a
node scripts/determinism-probes/objection-count-variance-probe.mjs   # full endpoint, shows UNCERTAIN↔BLOCK flip
node scripts/determinism-probes/provider-cascade-probe.mjs           # serv-nano + serv-swift stable in isolation
node scripts/determinism-probes/provider-determinism-probe.mjs       # serv-nano structured verdict stable
```
