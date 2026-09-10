# Changelog

## Unreleased

### Added

- **Health `rate_limit` + limiter-aware `ready` (issue #43):**
  `GET /sentinel/health` now includes `rate_limit: "redis" | "in_memory" |
  "unavailable"`. `ready` is false when Redis is configured-but-invalid
  (fail-closed limiter) **or** when `SERV_API_KEY` is missing. `ok`
  stays liveness-only; `serv_key` is unchanged (`present` | `missing`,
  never the value). Dogfood: `curl -sS https://sentinel.thoughtproof.ai/sentinel/health`
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
  unknown-mandate allowlist symmetry remains #49 (out of scope here).

### Changed

- **Single 120/min constant + burst default (issue #43):**
  `src/rate-limit-policy.json` is the source for authenticated 120/min,
  global 30/min default, 60s window, 503 `Retry-After: 30`, and burst
  `BURST_N` default 140. Upstash `slidingWindow` uses the same number
  as `checkRateLimit` callers, OpenAPI, ADR-0021, and
  `scripts/rate-limit-burst-check.mjs`. Burst expected mix: ~120 × 400
  validation, then 429 + `Retry-After`. `503 RATE_LIMIT_UNAVAILABLE`
  means Redis is still broken.

### Fixed

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
  Follow-up (not this change): deploy-action vs unknown-mandate
  allowlist asymmetry (`informationalActionMayPublicAllow('deploy_ship',
  'unknown') === true`).
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
