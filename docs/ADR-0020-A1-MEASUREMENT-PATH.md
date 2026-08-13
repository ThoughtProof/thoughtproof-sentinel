# ADR-0020 A1 Measurement Path (flag-off → canary → rates)

**Status:** ACTIVE prep · 2026-08-13  
**Code pin:** `ebb8fe6` on `main` · prod alias `sentinel.thoughtproof.ai`  
**Flag:** `SHADOW_ADR0020` **unset/off** (no activation yet)

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
| **Log drain (A1 gate)** | **FAIL** — no drain covering `thoughtproof-sentinel` |
| Vercel integrations | **0** resources |
| Third-party log env (Axiom/Datadog/…) | **none** |
| Team billing plan | **hobby** (API) |
| Runtime log retention without drain | UI-only: Hobby ≈ **1 hour** (Vercel docs); **not enough for A1** |
| Drain check script | `scripts/a1-log-drain-check.mjs` · report `reports/a1-log-drain-check-*.json` |

### Gate verdict (authoritative)

```
A1_log_drain_retention = FAIL
→ pilot producer  BLOCKED
→ SHADOW_ADR0020=on  BLOCKED
→ A2/A3  still blocked
```

Unblock only after: external log drain on this project (prod runtime logs) with **≥7d** searchable retention (prefer 30d), then re-run `node scripts/a1-log-drain-check.mjs` → PASS.

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

## 3. Vercel log queries (skeleton)

Vercel Runtime Logs / Log Drain. Adapt to your drain (Axiom/Datadog/etc.).

### 3.1 All shadow events (last 24h)

```text
"type":"adr0020.shadow"
```

### 3.2 Eligible count

```text
"type":"adr0020.shadow" "would_escalate":true
```

### 3.3 Errors / disabled

```text
"type":"adr0020.shadow" ("shadow_status":"error" OR "shadow_status":"disabled")
```

### 3.4 Rate definitions (compute offline from counts)

```
eligible_all     = count(would_escalate=true) / count(sentinel verify requests)
eligible_review  = count(would_escalate=true ∧ source_verdict=UNCERTAIN|canonical=REVIEW)
                   / count(source_verdict in {UNCERTAIN} on shadow events)
                   # better: join to full verify volume if available
invalid_input    = count(trigger_code=invalid_input) / count(shadow ok+error)
mutation_live    = must remain 0 (no body field; watch error_code=mutation_blocked)
```

**Forbidden claim:** pack offline 10/25 = 40% prod prevalence.

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

- [x] Confirm where prod runtime logs are retained (Vercel UI only vs drain) → **UI only, no drain**
- [ ] **GATE:** Add log drain for `thoughtproof-sentinel` prod runtime logs (≥7d, prefer 30d)
- [ ] Re-run `node scripts/a1-log-drain-check.mjs` until PASS
- [ ] Choose single pilot producer + wire `required_conditions` + `action_hash` (**after** drain PASS)
- [ ] Dashboard or saved queries for rates in §3 (on drain side)
- [ ] Explicit **go** from Raul for canary flag-on

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
