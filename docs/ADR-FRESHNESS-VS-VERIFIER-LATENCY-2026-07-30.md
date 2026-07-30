# ADR: Quote freshness vs verifier latency
**Status:** Accepted (spec) · 2026-07-30  
**Context:** Mandate “quote ≤ 60s” collides with Sentinel latency (5–45s) + replan if freshness is measured only as `server_now - quote_ts` at verify time.

## Decision

**Freshness is evaluated against when the agent built the decision package and when source evidence was observed — not against how long ThoughtProof took to verify.**

Verifier latency is an **infrastructure / SLO** outcome. It must not be classified as an agent mandate violation or folded into agent reliability rates / reputation.

v0.8 boundary demos remain valid: extreme ages (e.g. 760s) are independent of verify delay.

## Separation of concerns

### In the **mandate** (user / agent policy)

| Field | Meaning |
|---|---|
| `quote_observed_at` | When the market quote/mark was observed (prefer source or trusted collector time) |
| `decision_created_at` | When the agent sealed the decision package |
| `quote_max_age_at_decision_ms` | Max `decision_created_at - quote_observed_at` |
| `quote_max_age_at_settlement_ms` | Max age allowed immediately before sign/broadcast (wider budget) |
| `max_clock_skew_ms` | Allowed \|server_received_at - decision_created_at\| |

### In **verifier config** (not user mandate)

| Field | Meaning |
|---|---|
| `max_verify_latency_ms` | SLO for the check |
| `on_verify_timeout` | e.g. `UNCERTAIN_RETRY` / fallback tier / human |

Sentinel **adds**: `server_received_at`, `verify_started_at`, `verify_completed_at`, later `settlement_checked_at`.

## Checks

### 1) On intake (decision integrity)

```
decision_created_at - quote_observed_at  ≤  quote_max_age_at_decision_ms
|server_received_at - decision_created_at| ≤  max_clock_skew_ms
```

- First fail → **STALE_EVIDENCE_AT_DECISION** (agent used old data when deciding).
- Second fail → **TIMESTAMP_UNTRUSTED** (skew / transport) — **not** automatic STALE.

Prefer a **deterministic ms pre-check** before multi-model cascade.

### 2) During verify

Quote continues to age; that does **not** rewrite the quality of the original package.

If verify exceeds SLO → **VERIFY_TIMEOUT** → UNCERTAIN / retry — **not** STALE_EVIDENCE.

### 3) Immediately before settlement (execution lane)

```
settlement_checked_at - quote_observed_at  ≤  quote_max_age_at_settlement_ms
```

Fail → **SETTLEMENT_QUOTE_EXPIRED** → no sign → re-quote → **new** action params + **new** decision package hash → verify again.

This second TTL belongs in a **fast deterministic** path (authz/execution), not a full cascade replay.

## Taxonomy (do not collapse)

| Code | Who owns it | Reaction |
|---|---|---|
| `STALE_EVIDENCE_AT_DECISION` | Agent decision quality | New data + new plan |
| `VERIFY_TIMEOUT` | Infrastructure | Retry/fallback — **no agent penalty** |
| `SETTLEMENT_QUOTE_EXPIRED` | Time-to-settle | Re-quote, rebind action, new package |
| `TIMESTAMP_UNTRUSTED` | Clock/provenance | Fix time source or fresh evidence |

Only the first is a **decision-integrity** failure eligible for agent-side integrity rates.  
Verifier latency must not enter negative reputation or “hallucination” rollups.

## Replan rules

### Replan → HOLD / STAND_DOWN
- No market execution → quote freshness often **not eligible**.
- Prefer resolution: `NOT_APPLICABLE_AFTER_STAND_DOWN` rather than “resolved by refresh” if no new quote was fetched.
- v0.8: drawdown may remain unresolved while trade is removed — correct.

### Replan → still wants to trade
- **New** quote (`quote_observed_at`)
- **New** minOut / slippage / calldata bound together
- **New** decision package hash
- Full verify again  
Do not swap quote text while keeping old tx parameters.

## Pipeline (target)

1. Deterministic freshness (+ amount/recipient) pre-check — milliseconds  
2. Semantic cascade only if package is formally fresh at decision  
3. OBJECT on other grounds → replan  
4. Action-bearing replan → refreshed evidence + new hash  
5. Pre-sign: deterministic settlement TTL  

## Backdating / provenance (pilot → stronger)

Pilot: skew check + server receive time.  
Stronger later: signed provider timestamp, oracle block time, trusted fetcher `retrieved_at` + response hash (as in AsterPay provenance fields).

## Non-goals

- Putting `max_verify_latency_ms` into the **user mandate**
- Treating cascade duration as `STALE_EVIDENCE`
- Rewriting v0.8 demos solely for latency (760s already decisive)

## One-liner

> Freshness bounds the market data the agent **used** at decision time; settlement may add a second wider TTL; verifier slowness is infrastructure, not mandate breach; action-bearing replans must bind fresh evidence to a new package hash.

## Related

- Boundary v0.8 artifact (demo ages extreme)  
- Failure taxonomy v0 — extend with codes above when implementing  
- GOAT / Intuition: same rules; Intuition rates must exclude VERIFY_TIMEOUT from agent failure numerators  
