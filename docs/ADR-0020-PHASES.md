# ADR-0020 Shadow Phases (authoritative split)

**Status:** locked 2026-08-13 · supersedes any ADR wording that says “shadow fires RV”

The observe-only path is split into three **separate** goes. Completing one never authorizes the next.

| Phase | Name | What runs | Affects verdict? | Status |
|---|---|---|---|---|
| **A1** | Q1 eligibility shadow | After final Sentinel snapshot: Q1 judge → log `would_escalate` event only | **No** | **This PR** (flag default off) |
| **A2** | RV result shadow | Future explicit go: build Q2 package, call RV, **log only** | **No** | Not started |
| **A3** | Live semantic merge | Future explicit go after targeted suite + Full80: merge rules may sharpen REVIEW→BLOCK | Yes (sharpen only; never REVIEW→ALLOW) | Not started |

## A1 rules (current PR)

- Hook only after final response snapshot is built
- `SHADOW_ADR0020` default **off**
- No RV import/call
- No response mutation
- Shadow event fields include:
  - `binding_source: "caller_asserted"` (v0)
  - `eligible_for_q2_decision: false`
- Caller-asserted bindings measure structure frequency only — not proof validity for Q2

## Activation blockers (not merge blockers)

Flag-on requires separate go after:

1. Server-derived / verified binding state (not caller assertions alone)
2. Real log drain + retention
3. Observed mutation counters = 0
4. Production rates measured (`eligible/all`, `eligible/REVIEW`)

## Contradiction cleanup

Any text that says “when Q1 would fire: run RV in parallel” refers to **A2**, not A1.
Any text that says “shadow runner: fire RV with Q2 package” refers to **A2**, not A1.

A1 = eligibility telemetry only.
