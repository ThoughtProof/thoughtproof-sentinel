# ADR-0020 A1 Measurement Path (flag-off → canary → rates)

**Status:** A1 CANARY LIVE · 2026-08-13  
**Code pin:** `main` @ pilot+sink · prod alias `sentinel.thoughtproof.ai`  
**Flag:** `SHADOW_ADR0020=on` (production canary)  
**Canary runbook:** `docs/ADR-0020-A1-CANARY.md`

This doc is the operational path **after** A1 code merge. Completing it does **not** authorize A2/A3.

---

## 0. Current live state (verified 2026-08-13)

| Check | Result |
|---|---|
| Prod deploy | `dpl_8Tg79v1h2eMocuBAShQeL1mVHtyK` · Commit **ebb8fe6** · Ready |
| Alias | `sentinel.thoughtproof.ai` → that deploy |
| `SHADOW_ADR0020` in Vercel prod env | **absent** (= off) |
| Health | 200 |
| Minimal verify | 200, body has **no** `shadow` field |
| Free-text `action_hash` | **400** (`Must be 0x followed by exactly 64 hex characters`) |
| Structured conditions + canonical hash | 200, body still shadow-free |
| Smoke artifact | `reports/a1-flag-off-smoke-*.json` · script `scripts/a1-flag-off-smoke.mjs` |
| Vercel log drain | optional — currently **0** (Hobby; not required if Upstash path used) |
| **A1 structured sink** | **Upstash** (`src/adr0020/shadow-sink.ts`) · TTL **30d** · fail-open · env-separated keys |
| Upstash prod env | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (already used by rate-limit) |
| Team billing plan | **hobby** (API) — UI runtime logs ~1h; **not** relied on for A1 |
| Gate script | `scripts/a1-log-drain-check.mjs` (accepts Vercel drain **or** Upstash sink) |

### Gate verdict model

```
A1_measurement_sink_retention = PASS iff
  (vercel_drain) OR (upstash configured ∧ TTL≥7d ∧ reachability OK)
→ pilot producer design  unblocked on PASS
→ SHADOW_ADR0020=on      still needs separate explicit go
→ A2/A3                  blocked
```

**Chosen path (2026-08-13):** Option 2 — app-side Upstash sink. No Vercel plan upgrade required.

---

## 1. Goals (A1 only)

1. Keep production verdict path identical with flag off (done).
2. Make shadow **measurable** before any flag-on:
   - log drain for `type=adr0020.shadow`
   - rate queries (`eligible/all`, `eligible/REVIEW`)
   - mutation counters stay 0 when flag later turns on
3. One controlled producer that sends `required_conditions[]` + canonical `action_hash`.
4. Separate explicit go before `SHADOW_ADR0020=on`.

**Non-goals:** A2 RV calls, A3 live merge, Full80, ModeQ, global flag-on.

---

## 2. Log contract (when flag later on)

Shadow emits one JSON line via `console.log`:

```json
{ "type": "adr0020.shadow", "schema_version": "adr0020.shadow.v0", "...": "..." }
```

### Required fields for dashboards

| Field | Use |
|---|---|
| `type` | filter `adr0020.shadow` |
| `would_escalate` | eligible absolute / rates |
| `eligibility_basis` | must be `caller_asserted_structure` in v0 |
| `source_verdict` / `canonical_verdict` | REVIEW share |
| `trigger_code` | distribution |
| `missing_caller_asserted_bound_count` | histogram |
| `shadow_status` / `error_code` | reliability |
| `mutation` path | only via integration tests today; live must stay 0 |
| `action_hash` | always `0x`+64 hex or null |
| `binding_source` | `caller_asserted` |
| `eligible_for_q2_decision` | always `false` in A1 |

**Never in logs:** claim/evidence/mandate text, wallets, secrets, free-text hashes.

---

## 3. Upstash query model (primary)

Key prefix: `sentinel:a1:{env}` where `env` ∈ `production|preview|development|test|unknown`.

| Key | Type | Purpose |
|---|---|---|
| `…:evt:{event_id}` | STRING JSON · TTL 30d | full safe shadow event |
| `…:idx:ts` | ZSET score=ts · capped | recent event ids |
| `…:c:total` | counter · TTL refresh | emit volume |
| `…:c:eligible` | counter | `would_escalate=true` |
| `…:c:ok` / `…:c:error` | counters | reliability |

### Rates

```
eligible_all    ≈ GET c:eligible / GET c:total     # among shadowed requests only
eligible_review = scan/filter events where canonical_verdict=REVIEW ∧ would_escalate
invalid_input   = filter trigger_code=invalid_input
mutation_live   = watch error_code=mutation_blocked (must stay 0)
```

Console line `type=adr0020.shadow` remains best-effort (Hobby UI ~1h). **Do not** use pack 10/25 as prod prevalence.

### Sink properties

- fail-open (`persistShadowEvent` never throws to verify path)
- bounded write timeout 200ms
- no claim/evidence/mandate/PII fields in payload
- writes only when shadow emit runs (i.e. flag on later) — flag-off remains true no-op

---

## 4. Producer pilot (structured conditions)

Without callers sending structure, flag-on yields near-zero signal.

### Minimum request shape

```json
{
  "claim": "...",
  "evidence": "...",
  "mode": "action_authorization",
  "action_hash": "0x" ,
  "required_conditions": [
    {
      "condition_id": "alpha_required",
      "required": true,
      "proof_requirement": "machine",
      "evidence_bindings": []
    }
  ]
}
```

`action_hash`: exactly `0x` + 64 hex (lowercase preferred; API lowercases).

### Pilot candidates (pick one, no co-brand)

| Candidate | Why | Constraint |
|---|---|---|
| CB4A paper / internal | owned traffic | paper only; no public claim |
| verified-trading-agent testnet | already Sentinel-wired | no live fill requirement for A1 |
| offline replay → prod verify | controlled cases from measurement pack | rate-limit; not Full80 |

**Do not** attach structure to all prod arms on day one.

Helper script (local): `scripts/a1-structured-probe.mjs` (optional; creates N structured verifies for drain validation **after** flag-on go).

---

## 5. Flag-on canary plan (needs explicit Raul go)

| Step | Action | Gate |
|---|---|---|
| C0 | Log drain confirmed receiving *any* Sentinel logs | drain works |
| C1 | Set `SHADOW_ADR0020=on` **only** on production (or preview first) via Vercel env | kill switch = unset/delete env / set `off` |
| C2 | Re-run `node scripts/a1-flag-off-smoke.mjs` → body still shadow-free | HTTP invariance |
| C3 | Send 5–20 structured pilot requests | events appear in drain |
| C4 | 24–48h observation | mutation_blocked=0, error rate understood, rates recorded |
| C5 | Write rates into `reports/a1-canary-rates-YYYY-MM-DD.json` | before any A2 talk |

### Kill switch

```bash
# disable immediately
vercel env rm SHADOW_ADR0020 production -y
# or set off
echo off | vercel env add SHADOW_ADR0020 production
# redeploy if env change does not hot-reload for serverless cold starts
```

Serverless: new env applies on next deployment / cold instance. Prefer explicit redeploy after toggle.

### Canary stop conditions

- any evidence of response mutation / client-visible shadow fields
- elevated 5xx vs pre-canary baseline (investigate; shadow is fail-open but shared process)
- log volume / PII leak suspicion
- unclear error storm (`judge_throw` / `shadow_internal_error`)

---

## 6. Checklist

### Done

- [x] A1 merged to main (`ebb8fe6`)
- [x] Prod deploy + alias on that commit
- [x] Flag absent/off verified
- [x] Live smoke: health, hash validation, structured accept, no shadow in body
- [x] Smoke script checked in path: `scripts/a1-flag-off-smoke.mjs`

### Next (before flag-on)

- [x] Confirm Vercel UI-only logs insufficient (Hobby ~1h)
- [x] Choose Option 2: Upstash structured sink (TTL 30d)
- [x] Land sink code on `main` + prod deploy (flag still off) — `c6d12c1`
- [x] Re-run `node scripts/a1-log-drain-check.mjs` until PASS (Upstash path)
- [x] Single pilot producer wired: `src/adr0020/pilot-producer.ts` + `scripts/a1-pilot-producer.mjs`
- [x] Explicit **go** + canary activation 2026-08-13 (flag on, pilot-only live 5, sink writing)
- [ ] 24–48h rates review → then decide continue/kill / later A2 go

### Pilot producer (exactly one)

| Item | Value |
|---|---|
| ID | `adr0020.a1.pilot.v0` |
| Module | `src/adr0020/pilot-producer.ts` |
| CLI | `scripts/a1-pilot-producer.mjs` (`--live` optional; default dry-run) |
| Source | measurement pack `cases.jsonl` (structure only) |
| Bounds | ≤8 conditions, ≤4 bindings each |
| Strips | `valid_bound_evidence_count`, `valid_bound`, unknown/PII fields |
| Hash | canonical `0x`+64 hex (or structure-derived) |
| Tags | `caller_asserted`, `a1-pilot`, `flag_off_safe` |
| Does not | set flag, change verdict/cascade/policy, send raw evidence |

### Explicitly later

- [ ] A2 RV result shadow
- [ ] A3 live merge
- [ ] Full80 / ModeQ

---

## 7. Commands

```bash
# flag-off prod smoke (needs SENTINEL_API_KEY in env or known .env paths)
cd thoughtproof-sentinel && node scripts/a1-flag-off-smoke.mjs

# deploy pin check
vercel inspect https://sentinel.thoughtproof.ai  # or latest prod URL
# build log must show: Branch main, Commit ebb8fe6 (or newer intentional pin)

# env hygiene
vercel env ls production | rg SHADOW || echo 'SHADOW absent OK'
```

---

## 8. Decision log

| When | Decision |
|---|---|
| 2026-08-13 | A1 code merge authorized; flag-on **not** authorized |
| 2026-08-13 | Prod auto-deployed `ebb8fe6`; flag-off smoke **PASS** |
| TBD | Canary flag-on go / no-go |
