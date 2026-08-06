# Gate-0 #7 — Flip-rate measurement plan (n≥30)

**Goal:** Measure verdict flip rate on **byte-identical** inputs (owner RCA 2026-07-08 was n=5).  
**Not a product pivot** — claim hygiene + stability SLO input.

## Protocol
1. Freeze one ALLOW-shaped and one BLOCK-shaped fixture (claim+evidence+mode fixed JSON files).
2. Call `POST /sentinel/verify` **n=30** each with same body, tier=standard, spacing ≥2s.
3. Record: verificationId, verdict, confidence, objections hash, duration_ms.
4. Metrics:
   - `flip_rate` = fraction of consecutive pairs where verdict differs
   - `verdict_entropy` = unique verdicts / n
   - mode of verdict + support %
5. Pass bar (from strategy Gate-0): flip_rate ≤ 1% at n=30 preferred; document actual.

## Runner (next)
`scripts/flip-rate-run.mjs` — needs `SENTINEL_API_KEY` env; write results to `reports/flip-rate-YYYYMMDD.json`.

## Status
- [x] Plan written
- [ ] Runner implemented
- [ ] n=30 executed on prod or staging
- [ ] Numbers published next to any stability claim
