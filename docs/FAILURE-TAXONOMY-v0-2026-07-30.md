# Failure taxonomy v0 — Decision Integrity (reporting only)
**Date:** 2026-07-30  
**Status:** Frozen for pilot labelling · does **not** change Sentinel verdicts  
**Use:** Matt/Intuition aggregates · GOAT partner_view codes · cb4a backfill (heuristic until native)

## Rules

1. Taxonomy is a **reporting layer** on top of per-decision verification.  
2. It does **not** drive ALLOW/BLOCK by itself.  
3. Every rate needs a **denominator**: `eligible_checks` for that class in the window.  
4. Prefer **native** classification; mark `heuristic_backfill` when keyword-mapped.  
5. Do **not** roll into agent reputation without operator opt-in (`do_not_convert…`).

## Codes

| Code | Meaning | Typical resolvable? |
|---|---|---|
| `MANDATE_VIOLATION` | Action outside stated mandate (scope, asset, recipient class) | sometimes |
| `MANDATE_DRAWDOWN_BREACH` | Risk-on while portfolio DD exceeds mandate limit | often stand-down |
| `STALE_EVIDENCE` | Cited quote/mark older than mandate freshness | yes — refresh |
| `EVIDENCE_MISSING` | Required field absent from package | yes |
| `EVIDENCE_CONTRADICTION` | Thesis conflicts with provided numbers | yes |
| `UNSUPPORTED_CLAIM` | Claim in reasoning with no supporting evidence | yes |
| `WALLET_STATE_MISMATCH` | Claimed balances/positions ≠ evidence | yes |
| `MARKET_DATA_STALE` | Market inputs stale (alias/subclass of STALE when market-specific) | yes |
| `PRICE_MISMATCH` | Cited price inconsistent with evidence/oracle pack | yes |
| `PROCESS_REQUIREMENT_MISSING` | Required process step missing (approval, dual-control) | depends |
| `OTHER` | Does not fit; must include free-text | — |

## Classification record (per objection or per decision)

```json
{
  "code": "STALE_EVIDENCE",
  "severity": "medium",
  "eligible": true,
  "evidence_refs": ["evidence.quote.age_seconds"],
  "classification_source": "native|heuristic_backfill|human_review",
  "message": "Quote age 760s > 60s"
}
```

`severity`: `low` | `medium` | `high` (reporting only).

## Windowed integrity report (later)

```json
{
  "agent_id": "…",
  "window": { "from": "…", "to": "…", "n_decisions": 50 },
  "eligible_checks_by_class": { "STALE_EVIDENCE": 40, "MANDATE_DRAWDOWN_BREACH": 12 },
  "failures_by_class": { "STALE_EVIDENCE": 5, "MANDATE_DRAWDOWN_BREACH": 3 },
  "rates_by_class": { "STALE_EVIDENCE": 0.125 },
  "grade": null,
  "reporting_only": true
}
```

## Mapping from v0.7 boundary demo

| Demo code | Taxonomy v0 |
|---|---|
| STALE_EVIDENCE | same |
| MANDATE_DRAWDOWN_BREACH | same |
| UNSUPPORTED_CLAIM | same |
| EVIDENCE_CONTRADICTION | same |

## Non-goals v0

- Automatic grade AAA/B  
- Changing cascade prompts  
- Graph write format finalization (use validation artifact + these codes as payload)
