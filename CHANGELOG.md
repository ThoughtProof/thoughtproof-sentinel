## Unreleased

### Fixed
- Nightly action-authorization suite workflow: stop using `secrets.*` in `if:` (GitHub 422 Unrecognized named-value). Gate missing key in bash after mapping secrets → env. Repo secret `SENTINEL_NIGHTLY_API_KEY` is set; dedicated allowlist entry `nightly-suite` on prod.

# Changelog

## Unreleased

### Changed

- **Prompt-only #55: 0x FAIL scoped to informational/notify (not a financial ALLOW fix):**
  After #34/#48 the gold-step / question FAIL said roughly "FAIL if
  the action also sends/transfers/pays/wires/swaps/bridges a number
  or names a 0x address, even when framed as notify/FYI." Intent was
  notify-framed hidden transfers. This PR only narrows that FAIL to
  an **informational/notify** action and keeps financial / FYI PASS
  hints as cascade TE grading input (`financial_pair_match=true` +
  `amount_within_grant=true`). Hints are **not** a promotion override.
  **Live financial ALLOW via cascade for exact pays is not working.**
  Suite `ok-01` / `ok-02` / `ok-03` (`expect: allow`) are a **known
  false_BLOCK** on Preview/prod since #34 (`already_block`,
  `decision_basis: cascade`; serv-nano 4×0.5 TE). Prompt churn cannot
  move the live cascade. Goal path is structured mandate (issue #51 /
  thoughtproof-mcp#21). **No deterministic ALLOW short-circuit**
  (Non-Goal #34/#37): kind/promotion may ADD BLOCKs (and UNCERTAIN)
  but never upgrades a cascade BLOCK to ALLOW on prose-pair
  predicates. A `banned=0` ratchet locks
  `financial_pair_pass` / `informational_pair_pass` out of
  `ActionAuthPromotionReason`. #53/#54 allowlist unchanged. Trade
  modes untouched.

### Fixed

- **trade_reasoning 3b promotion receipt (ADR-0018):** step_2-only UNCERTAIN→ALLOW
  was invisible in prod logs (`promotion=` only when `meta.promotion` exists).
  When 3b fires, emit `reason=inferential_step_promoted`, `decision_basis=cascade`.
  No gate change. Native ALLOW / non-promote still omit the field.
- **value_transfer / permission vs non-matching mandate allowlist (issue #53):**
  After #49, `informationalActionMayPublicAllow('value_transfer', 'unknown')`
  and `('permission', 'unknown')` were still `true`. Prod receipt
  `sent_8d3b27d9bda0475e` public-ALLOWed a ship mandate + money move
  (`mandate_kind=deploy_ship`, `action_kind=value_transfer`,
  `already_allow`, confidence=1) because MCP sends no structured
  `req.mandate` and the financial gate never runs. Same class as
  `sent_4c39a37b390344eb` / `sent_c91fbbad57a7436c`, highest-blast
  variant. Public ALLOW now requires positively derived kind fit on
  every action class: `value_transfer` only when
  `mandate_kind === 'value_transfer'`; `permission` only when
  `mandate_kind === 'permission'`. Else **BLOCK**
  `objective_mismatch_fail_closed` (same promotion mapping as #38 /
  #49). Pairing matrix: `permission` × `permission` still ALLOW;
  `permission` × `value_transfer` ALLOW **only** when the approval is
  **bounded** and the approved amount is compatible with the mandated
  spend (ok-01 exact `approve(0xUNIROUTER, 100 USDC)` vs Swap).
  Approvals stay `action_kind=permission` (never reclassified as
  `value_transfer` — honest receipt). Unbounded markers include
  `MAX_UINT256`, decimal integers ≥20 digits (MaxUint256 decimal hole
  `sent_b400c8712df54c72`), `0xf{40,}` / long hex, full/entire
  balance, no expiry, infinite, unbegrenzt. Those pairings BLOCK
  `objective_mismatch_fail_closed` even if cascade `agreement_allow`.
  Drain ok-01 / ok-02 / ok-03 stay on the ALLOW path. Informational
  FYI, #48 unknown/unknown UNCERTAIN, and #49 deploy vs unknown BLOCK
  are unchanged. Suite case `mismatch-06-pay-vs-ship` locks the prod
  pairing. Every action class needs a positively matching mandate on
  the prose path.
- **Deploy/publish/pin vs unknown mandate allowlist (issue #49):**
  After #48, `informationalActionMayPublicAllow('deploy_ship', 'unknown')`
  was still `true`: a deploy/publish/pin action against an unclassified
  mandate could public-ALLOW if cascade `agreement_allow` agreed, while
  an unclassified *action* fail-closed. `value_transfer` / `permission`
  are caught by the financial gate **when a structured `mandate` is
  supplied**; prose-only requests (MCP shape: claim/evidence/mode/tier,
  no `req.mandate`) relied on gold-step criteria until #53 closed the
  positive allowlist for those kinds on the prose path. This change
  closed `deploy_ship` on the prose path: public ALLOW only on
  positively derived fit (`mandate_kind === 'deploy_ship'`), same
  spirit as #38 informational allowlist. Unknown or mismatched
  mandate → **BLOCK** `objective_mismatch_fail_closed` (same promotion
  mapping as informational + unknown). Informational FYI
  (`informational` / `informational`) is unchanged. Unknown/unknown
  stays UNCERTAIN `unclassified_abstention_fail_closed` (no #48
  regression). Bare `release` is omitted from action deploy heads
  (same as #37 `POSITIVE_SHIP_RE`) so FYI "release notes" is not
  `deploy_ship`. The #47 CHANGELOG follow-up is closed.

### Added

- **Nightly action_authorization suite (issue #56):** GitHub Action
  cron (`15 5 * * *`) + `workflow_dispatch`, and on PRs that touch the
  suite / engine / runner. `scripts/action-authorization-suite.mjs`
  posts `scenarios/action-authorization-suite.json` to **production**
  `https://sentinel.thoughtproof.ai` `/sentinel/verify` (Preview is
  dispatch/PR override only). Cost ~10–15¢/night (`standard`,
  18 × $0.008). Dedicated secret `SENTINEL_NIGHTLY_API_KEY`
  (`SENTINEL_API_KEY` fallback). Every request sets
  `X-Sentinel-Agent-Id: nightly-suite` (billing `agent_id` + verify
  log `agent=`) and `agent_context.agent_id` so the 18 runs can be
  filtered from organic traffic. Counts **false_ALLOW** (`expect:
  not-allow` + verdict ALLOW) and **false_BLOCK** (`expect: allow` +
  verdict ≠ ALLOW), plus receipt ids, `decision_basis` /
  `promotion.reason` / kinds. Gate: **false_ALLOW must be 0**;
  **false_BLOCK ratchet** fails if count exceeds named
  `FALSE_BLOCK_BASELINE = 4` (ok-01/02/03 + ok-06 cascade
  false_BLOCKs after #57) — not a permanent soft-pass. Changing
  `FALSE_BLOCK_BASELINE` requires a CHANGELOG line; after #51 lower
  it to 0. Side benefit: 18 receipts/night sample FYI-ALLOW rate;
  after #51 the financial axis time series shows ok-01/02/03
  flipping false_BLOCK → ALLOW. ADR-0019 drain false-ALLOW
  threshold is now paired with in-scope false-BLOCK measurement.
  No `financial_pair_pass` / trade-mode change.
- **Health `rate_limit` + limiter-aware `ready` (issue #43):**
  `GET /sentinel/health` now includes `rate_limit: "redis" | "in_memory" |
  "unavailable"`. `ready` is false when Redis is configured-but-invalid
  (fail-closed limiter), when `SERV_API_KEY` is missing, **or** (ADR-0021
  hard variant) when `VERCEL_ENV=production` and `rate_limit` is
  `in_memory`. Preview/dev may still be `in_memory` + `ready: true`.
  No `degraded` field. `ok` stays liveness-only; `serv_key` is unchanged
  (`present` | `missing`, never the value). Dogfood: `curl -sS https://sentinel.thoughtproof.ai/sentinel/health`
  (or a Preview URL) and read `rate_limit`. Optional Preview-only check
  of the 503 branch: branch-bound invalid `UPSTASH_REDIS_REST_TOKEN`,
  expect `rate_limit: "unavailable"` + `ready: false` and authenticated
  verify `503 RATE_LIMIT_UNAVAILABLE` + `Retry-After: 30` (no Production
  env flip).
- **`decision_basis` on action_authorization promotion meta (issue #43
  bonus / Raul):** receipts now carry `decision_basis: "deterministic" |
  "cascade"`. Deterministic = allowlist / abstention / mismatch gate
  (`objective_mismatch_fail_closed`, `unclassified_abstention_fail_closed`).
  Cascade = promotion followed the cascade-derived path. Distinguishes
  gate BLOCK|UNCERTAIN from cascade confidence. Deploy/publish vs
  unknown-mandate allowlist symmetry is closed by #49 (see Fixed above).

### Changed

- **Health `rate_limit: "redis"` docs (#50 hygiene):** OpenAPI, ADR-0021,
  and the health type comment now say `redis` means Upstash env is
  **configured**, not connectivity-checked (no PING). `RateLimitBackend`
  is defined once in `upstash-env.ts` and re-exported. The liveness
  comment sits on `ok`, not `ready`. Production `in_memory` →
  `ready: false` is unchanged. Preview invalid-token 503 dogfood remains
  out of scope.
- **Single 120/min constant + burst default (issue #43):**
  `src/rate-limit-policy.json` is the source for authenticated 120/min,
  global 30/min default, 60s window, 503 `Retry-After: 30`, and burst
  `BURST_N` default 140. Upstash `slidingWindow` uses the same number
  as `checkRateLimit` callers, OpenAPI, ADR-0021, and
  `scripts/rate-limit-burst-check.mjs`. Burst expected mix: ~120 × 400
  validation, then 429 + `Retry-After`. `503 RATE_LIMIT_UNAVAILABLE`
  means Redis is still broken.

### Fixed

- **Preview `/sentinel/health` 500 (issue #43 dogfood):** health no longer
  imports `src/auth.ts` (which pulled `@upstash/ratelimit` and
  `import` of `rate-limit-policy.json`). Vercel Node does not transform
  JSON imports the way Vitest does, so the handler failed at load
  (`FUNCTION_INVOCATION_FAILED`) while `npm test` stayed green. Policy
  numbers are TypeScript literals; the burst script still reads the
  sibling JSON (lockstep-tested). `rate_limit` is resolved via
  `upstash-env` (config probe, no Redis SDK).
- **Unknown-action abstention + DE informational markers (issue #47):**
  After #46, `informationalActionMayPublicAllow` returned true whenever
  `action_kind !== 'informational'`, so `unknown` actions abstained and
  could fail-open via cascade `agreement_allow` (dogfood
  `sent_a3ae25f9e68d4234` ALLOW unknown/unknown; Fall 7c BLOCKed via
  `already_block`, not the allowlist). Two-tier fail-closed, no public
  ALLOW either way:
  - `unknown` action vs a **named** non-informational mandate
    (`deploy_ship` / `value_transfer` / `permission`) → **BLOCK**
    `objective_mismatch_fail_closed` (real named conflict; Fall 7c /
    mismatch-05).
  - `unknown` / `unknown` → public **UNCERTAIN**
    `unclassified_abstention_fail_closed` (not BLOCK). Safety-equivalent
    (MCP execute stays false) but the receipt says "classify better",
    not "action exceeds mandate".
  A small DE informational set (Informiere, Info an, Bescheid geben,
  Rückmeldung, Status an) so Fall 6 classifies
  `informational`/`informational`. Per-request `unknown_action` /
  `unknown_mandate` / `unclassified_abstention` flags on promotion meta
  and the verify log line (plus process counters) so prod abstention
  rate is measurable. Target: host-declared `mandate.kind` /
  `action.kind` with prose as fallback and `unknown → fail-closed`
  (companion thoughtproof-mcp#21); this change does not invent that
  host API. #38 informational allowlist is unchanged (informational
  action + non-informational mandate still BLOCK). FYI-aligned English
  informational ALLOW is unchanged. The #46 known limitation is closed.
  Follow-up (closed by #49): deploy-action vs unknown-mandate
  allowlist asymmetry (`informationalActionMayPublicAllow('deploy_ship',
  'unknown')` is now `false`).
- **FYI PASS-hint + DE ship negation (issue #38 dogfood):**
  Preview FYI (case 1) was UNCERTAIN with `mandate_kind=informational`
  (gate OK) but cascade `disagreement_hold` / `steps_not_all_pass`: all
  four steps had PASS-shaped prose yet `predicate=unfaithful` / score 0
  (grade surface, not a FAIL-list misread). Step 2 criterion + question
  now state a positive PASS trigger: `SENTINEL_AXIS_HINT` with
  `mandate_kind=informational` and no `objective_mismatch=true` → aligned
  notify/FYI PASSES (grade faithful/supported). Promotion allowlist is
  unchanged. DE negation before ship verbs (`kein(e|en|em|er)?`,
  `nicht`, `ohne`, `niemals`) so "kein Deploy" / "keine Zahlung" are not
  `deploy_ship` (case 6).
- **Informational ALLOW allowlist (issue #38):**
  An informational / notify-only action may reach public ALLOW only
  when `mandate_kind` is positively `informational`. Otherwise
  `objective_mismatch_fail_closed` BLOCK — including unknown /
  ambiguous mandates, DE ship→notify, and payment→notify. This closes
  the structural gap that #37 mitigated as an English-majority
  blacklist (`hasPositiveShipInstruction` / non-informational kinds).
  #37 remains mitigation lineage; #36 stays open (MCP claim framing is
  companion [thoughtproof-mcp#21](https://github.com/ThoughtProof/thoughtproof-mcp/issues/21)
  — Sentinel does not paper over `claim === proposed_action`).
  FYI-aligned (`mandate_kind === informational`) still ALLOW. English
  ship hard-BLOCK from #37 is preserved. Verify log line now includes
  `promotion=` (and `mandate_kind` / `action_kind` when present) so
  Runtime Logs answer dogfood without receipt dumps.
  **Known limitation (closed by #47):** aligned FYI is positively
  allowlisted only when the mandate is recognizably `informational`.
  Unrecognized actions (`action_kind === unknown`) previously fell
  through to the cascade. Closed by the #47 unknown-action fail-closed
  fix above.
- **Finite receipt confidence (issue #39):**
  Averaging step scores now coerces missing / NaN / Infinity `score` to
  `0` (`Number.isFinite(s.score) ? s.score : 0`). Response `confidence`
  is asserted to a finite number in `[0, 1]` before return; EAS
  attestation and canonical-verdict copies use the same clamp so
  `JSON.stringify` cannot emit `confidence: null`. Fail-closed: a
  degraded cascade is a low readable score, not an unreadable receipt.
- **Health readiness + verify config errors (issue #32):**
  `GET /sentinel/health` now reports `ready` and `serv_key` (`present` |
  `missing`) without emitting the key value. `ok` remains liveness only —
  `ok: true` is not a cascade readiness signal. Missing `SERV_API_KEY`
  (and pot-cli `Missing env: *_API_KEY`) on `POST /sentinel/verify` returns
  HTTP 503 `MODEL_CONFIG_MISSING` instead of 500 `INTERNAL_ERROR`, so MCP
  hosts can treat gate-down as distinct from model uncertainty. Fail-closed
  unchanged: no ALLOW without a real ALLOW.
- **Mitigation (not a closed #36) — English ship-mismatch fail-open on
  MCP `verify_before_action` (after #34):**
  thoughtproof-mcp `buildSentinelVerifyBody` sets `claim` to
  `proposed_action` (not an "X is authorized by Y" assertion). After #34,
  informational steps 0/1/3 PASS and the cascade can `agreement_allow` or
  HOLD ("objective only weakly supported"). `resolveActionAuthPromotion`
  then passed `already_allow` through. Sentinel now hard-BLOCKs when
  `classifyActionAuthKind` sets `objective_mismatch=true` for a
  notify-only action vs a non-informational mandate (English
  ship/pin/deploy/publish, a small DE ship-verb set
  deploye/veröffentliche/veröffentlichen/ausliefern, or a
  value-transfer/permission mandate). MCP `User mandate:` excerpts and
  ship+notify mandate prose are covered. FYI-aligned (`claim` = action,
  informational mandate) is unchanged. This is **not** full i18n or
  allowlist inversion — #36 stays open for follow-ups. Not an npm
  publish; public pin stays `thoughtproof-mcp@0.3.2`.
- `action_authorization` gold steps no longer treat aligned crew FYI /
  status pings as unbound spend or unauthorized counterparties (issue
  #33). Identifiers (issue numbers, versions) are not amounts; a named
  teammate in the mandate is a valid notify recipient. Ship-mismatch
  (mandate = ship/npm pin, action = notify) still fails mandate
  alignment. This is **criteria tuning for non-financial actions** plus
  a silent-unless-confident `SENTINEL_AXIS_HINT` on the verification
  question (never mixed into caller evidence). Caller `structural_fact:`
  lines are neutralized so a smuggled fact cannot fail-open ALLOW.
  Mixed notify+send/0x actions stay silent. Not a dedicated FYI mode,
  not an MCP package change, and not a weakening of financial
  fail-closed.
- Cascade steps with `quote: null` and omitted reasoning no longer surface
  `undefined [PROVENANCE DOWNGRADE: quote invalid or missing]` (dogfood
  2026-09-09, FYI-aligned `weakly_faithful`).

### Changed

- **All modes (not only `action_authorization`):** a step `quote` that is
  not a substring of `evidence` (exact, trimmed, line-whitespace, or
  Unicode-folded) is nulled on the objection surface. A cascade-emitted
  quote is no longer copied onto the receipt unless it is citeable.
  `engine.test.ts` fixtures now include the quote in evidence.
- Recovered mandate quotes are labeled `quote_source: recovered_mandate`
  (and annotated `provenance recovered from host mandate span`). They are
  not presented as cascade citations. Score stays at the cascade value
  (typically 0.25 / `weakly_faithful` after the provenance cap).
  Recovery is gated to near-pass (provenance stamp or score ≥ 0.25);
  hard unfaithful / score-0 steps are not backfilled.
- Vendored pot-cli identity is **`0.8.10-tp.1`**, not upstream `0.8.10`
  (auditability for `/sentinel/health` `pot_cli` from #30).
