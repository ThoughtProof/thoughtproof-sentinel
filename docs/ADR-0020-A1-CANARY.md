# ADR-0020 A1 Canary (LIVE)

**Status:** LIVE · started 2026-08-13 ~20:43 CEST  
**Scope:** observe-only Q1 shadow · pilot producer only · no A2/RV · no verdict merge

## Activation

| Item | Value |
|---|---|
| Flag | `SHADOW_ADR0020=on` (Vercel production) |
| Deploy | `thoughtproof-sentinel-kcm2wvgdy` · aliased `sentinel.thoughtproof.ai` |
| Sink | Upstash `sentinel:a1:production:*` · TTL 30d · fail-open |
| Producer | `adr0020.a1.pilot.v0` only (`scripts/a1-pilot-producer.mjs --live`) |
| Non-goals | A2 RV, A3 live merge, Full80, ModeQ, global traffic producers |

## Initial live proof (t0)

| Check | Result |
|---|---|
| Health | 200 |
| Smoke (body invariance) | **7/7 PASS** — no `shadow` field on HTTP body |
| Pilot live | **5/5** HTTP 200 · `has_shadow_field=false` |
| Upstash counters | `total=7` · `ok=7` · `error=null` · `idx_len=7` |
| Sample event | `type=adr0020.shadow` · `sink=upstash` · `binding_source=caller_asserted` · `eligible_for_q2_decision=false` · `shadow_status=ok` |
| Eligible at t0 | `eligible=null/0` (pilot cases returned public **BLOCK** → Q1 `not_review`; expected) |

Note: pilot synthetic claim/evidence often yields BLOCK; structure still flows and is measured. Eligible rate needs REVIEW-shaped traffic or pack cases that stay UNCERTAIN/REVIEW in prod — track over 24–48h.

## Kill switch (immediate)

```bash
cd ~/PROJECTS/ThoughtProof/thoughtproof-sentinel

# 1) Turn flag off
printf 'off' | vercel env add SHADOW_ADR0020 production --force
# or remove:
# vercel env rm SHADOW_ADR0020 production -y

# 2) Redeploy so cold starts pick up env
vercel --prod --yes

# 3) Verify
vercel env ls production | rg SHADOW
node scripts/a1-flag-off-smoke.mjs
```

### Trip conditions → kill immediately

- client-visible `shadow` field or response drift vs pre-canary
- elevated 5xx / latency vs baseline
- Upstash `c:error` storm or sink timeouts dominating
- any PII/raw leakage suspicion in stored events
- unexpected `eligible_for_q2_decision=true`

## 24–48h evaluation

```bash
node scripts/a1-upstash-counters.mjs --env-file=<prod env pull>
# rates:
#   eligible/total from counters
#   error/total
#   idx growth
```

Record into `reports/a1-canary-rates-YYYY-MM-DD.json` before any A2 discussion.

## Explicitly still blocked

- A2 RV result shadow
- A3 live semantic merge
- Broad producer rollout beyond pilot
- Capacity claims from offline pack 0.40
