# Changelog

## Unreleased

### Fixed

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
