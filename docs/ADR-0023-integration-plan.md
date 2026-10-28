# ADR-0023 integration plan

**Status:** Proposed (2026-10-27). Do not merge without Raul GO.
**Parent:** [ADR-0023](ADR-0023-principal-signed-mandate.md) (Proposed). This plan does not change that status.
**Decider:** Founder

This document is a plan. It is not an implementation GO, not a suite GO, and not a per-account enablement GO. Accepting it does not authorize wiring the modules named below into the request path.

**Prerequisite note (2026-10-28).** Shared mandate normalization, the key-to-account mapping, and the no-auth failure class are specified in [Stage 4 prerequisites](#stage-4-prerequisites--normalization-key-mapping-no-auth) and implemented off the request path. That note is not a stage-4 wiring GO, not an enablement GO, and not a suite GO. `registerPrincipalKey` stays locked. No account is enabled. The replay store is not enabled.

## Paid-suite trigger paths

Read from the `pull_request` path filter in `.github/workflows/action-authorization-suite.yml` on main `ddc94114`:

- `scenarios/action-authorization-suite.json`
- `scripts/action-authorization-suite.mjs`
- `scripts/lib/action-auth-suite-metrics.mjs`
- `scripts/lib/action-auth-suite-receipt.mjs`
- `.github/workflows/action-authorization-suite.yml`
- `src/engine/**`

A later pull request starts that workflow when it changes any of those paths. The nightly `schedule` and `workflow_dispatch` triggers are separate. They are not a reason to run the suite from an implementation PR. None of the four stages below is allowed to edit those paths unless that PR has its own suite GO. The intended file lists avoid them.

## Global invariants

These hold in every stage. A later stage must not weaken an earlier one.

- A valid signature never upgrades a verdict to ALLOW. It may set `mandate_source` to `principal_signed` for the mandate that verified. The gate, the promotion, and the fail-safe still decide the verdict.
- A failed principal check never becomes ALLOW, including when v2 issuance fails and `signed_export_v2` is omitted.
- UNCERTAIN, an evaluator or handler error, HTTP 5xx, 401, and 429 never become ALLOW because a signature was present.
- An existing BLOCK is never weakened, including to UNCERTAIN.
- `principal_kid` is not publicly archived. It stays off the public receipt allowlist, together with the mandate plaintext, `mandate_proof.signature`, the salt, and the digest preimage.
- `caller_declared` is allowed only for an explicitly established legacy status. Unknown status is not `caller_declared`. Missing or unreadable account or policy data must never downgrade a protected account: reject the request with HTTP 503.
- An explicitly sent `mandate_proof` is always verified or rejected. It is never silently ignored, including for a legacy account.

## Stage 1 — Trusted account binding

**Goal.** `validateApiKey` returns a stable server-side account id for the authenticated key. Request fields and `X-Sentinel-Agent-Id` never substitute for it.

**Files and modules likely touched.**

- `src/auth.ts` — `validateApiKey` today returns `{ valid, error?, platform?, agent_id? }`. The key list is `SENTINEL_API_KEYS` entries of `key:platform:agent_id`. This stage adds a server-side account id to that result. When `SENTINEL_AUTH_REQUIRED` is not `true`, the function still returns `{ valid: true }` and must not invent an account id.
- `src/auth.test.ts` — offline tests for the new field.
- Not `api/sentinel/verify.ts` yet. That handler currently sets `agentId` from `X-Sentinel-Agent-Id` or `authResult.agent_id` for billing logs only. Leaving that line in place is stage 4's problem to avoid copying it into the account id. This stage does not read the request body.

**Invariants.**

- The account id comes only from server-side key configuration.
- A body field (`account_id`, `agent_context`, `mandate`, `key_manifest`, or anything else) cannot set it.
- `X-Sentinel-Agent-Id` cannot set it. That header remains a caller-declared billing label.
- A missing mapping stays missing. It is not filled from the request. Missing or unreadable account data is not `caller_declared`, and it must not downgrade a protected account: reject with HTTP 503.
- 401 from a failed key check stays 401 and is never turned into ALLOW.

**Offline tests.** Pure tests of `validateApiKey` with env fixtures. No network and no provider keys. Cover: a configured key returns its server account id; a body account id and an `X-Sentinel-Agent-Id` value are not arguments to the function and cannot appear in the result; an unknown key is invalid; auth-not-required returns no account id.

**Paid-suite trigger paths.** No. `src/auth.ts` and `src/auth.test.ts` are outside the six paths above.

**Separate GOs.** An implementation GO for this stage only. It does not authorize stages 2–4, does not authorize a suite run, and does not authorize flipping any account off `caller_declared`. A suite GO is required only if the PR also edits a trigger path, which this stage must not do.

## Stage 2 — Shared atomic replay store

**Goal.** Expiry re-check and single-use nonce consumption happen in one atomic step in one shared store. There is no local fallback. A consumed nonce is kept at least until `exp + skew` (skew is 30 seconds).

**What already exists, and what it is not.** `checkWindowThenConsume` in `src/mandate-proof-window.ts` does not consume a nonce. It checks the time window at one clock reading and re-checks expiry at a second reading. It returns `{ ok: true }` or `{ ok: false, verdict: 'BLOCK', reason }`. It writes nothing, it does not mark a nonce used, and it is not on the request path. A store implementation must not treat a successful return from that function as consumption.

**Files and modules likely touched.**

- A new module outside `src/engine/**`, for example `src/mandate-replay-store.ts`, plus an offline test beside it.
- Not `src/auth.ts` rate limiting. `checkRateLimit` falls back to memory when Redis env is unset. The replay store must not share that fallback.
- Not `src/mandate-proof-window.ts` unless a later implementation GO explicitly extends it. Time checks stay pure. Consumption stays in the store.

**Invariants.**

- One store serves every instance. Two parallel requests with the same nonce must not both pass.
- The atomic step re-checks `exp > now - 30` against server time and inserts the nonce together. That check inside the atomic operation is the authoritative time check. An earlier check, including `checkWindowThenConsume`, does not satisfy it. If the proof has expired, the step does not consume it and the result is BLOCK, never ALLOW.
- If the store does not answer, the result is UNCERTAIN / HTTP 503. There is no in-memory pass and no retry of the same proof from the start.
- A consumed nonce is retained at least until `exp + skew`. An entry that disappears earlier is a failed test, not an accepted replay.
- The time rules from ADR-0023 still apply, including `exp > iat`. A zero-length window is BLOCK before the store is asked to spend a nonce.

**Offline tests.** A fake clock and an in-test double of the store can check call sequencing. A store test double does not prove atomicity. Before enablement, local tests of the actual storage operation are required, with concurrent requests and expiry boundaries. Those tests are local: no model call, no provider key, and not the paid suite. Cover: first consume succeeds; the same nonce consumed again is BLOCK; `exp` equal to `now - 30` at the consume instant is BLOCK and leaves no spent nonce; a store error is UNCERTAIN and writes nothing locally; an entry is still present at `exp + skew`; `checkWindowThenConsume` is asserted not to be the consuming call (it has no nonce argument and no store). The concurrent requests and the expiry boundaries run against the actual storage operation, and the authoritative time check is inside that operation.

**Paid-suite trigger paths.** No, if the new module stays outside `src/engine/**` and the PR does not edit the other five paths. Putting the store under `src/engine/**` would start the suite and is out of scope without a suite GO.

**Separate GOs.** An implementation GO for the store and its retention rule. It does not choose a production backend by itself if that backend is still an open question below, and it does not authorize wiring the store into `POST /sentinel/verify`. No suite GO while the files stay off the trigger list.

## Stage 3 — Per-account Ed25519 manifest

**Goal.** Each account has a server-pinned Ed25519 public-key manifest, registered through a process that is separately authorized. The agent cannot register its own key. A retired key accepts no new request. The key must be `active` at receipt time.

**Files and modules likely touched.**

- A new manifest module outside `src/engine/**`, keyed by the stage 1 account id, plus offline tests.
- A registration entry point that is not `POST /sentinel/verify` and not the verify handler in `api/sentinel/verify.ts`.
- `src/types.ts` is context only. `KeyManifest` / `key_manifest` is the caller-supplied F1 evidence manifest. The trust note on that field says it proves a key the caller named. This stage must not reuse that type as the principal manifest.
- Not `/.well-known/thoughtproof-keys.json`. That file is the export JWKS. A caller-supplied JWKS URL stays rejected.

**Invariants.**

- Sentinel stores the public key only. The principal holds the private key.
- The verify caller cannot add, retire, or revoke a kid. An API key or `X-Sentinel-Agent-Id` is not registration authority.
- `principal_kid` selects one key in the manifest for the authenticated account, not a key in the request.
- `active` means `notBefore <= now < notAfter` for each bound that is set. `notAfter` is exclusive. A null bound is open on that side. The 30-second proof skew does not apply. A signer-chosen `iat` does not widen the window. If both bounds are set, `notAfter` must be greater than `notBefore`; otherwise the manifest is invalid and the result is HTTP 503.
- `notBefore` and `notAfter` are strict RFC3339 UTC timestamps (`YYYY-MM-DDTHH:MM:SSZ`) that round-trip through the calendar. A value `Date.parse` would normalize, such as `2026-02-30T00:00:00Z`, makes the manifest invalid (HTTP 503).
- `retired` is BLOCK for any new authorization. Historical verification of a retired key is out of scope for this stage. `revoked` is BLOCK, including inside any old window.
- The manifest document carries `accountId` in addition to the store key. The store is read only for the authenticated account. A different `accountId` on the delivered document is HTTP 503. A different `account_id` in the signed proof is BLOCK and does not select the store key.
- v1 `environment` is exactly `production`, `preview`, or `development`. It is compared to a trusted server-side target environment injected by the caller, not taken from the manifest or the proof. Any other proof value, including whitespace, is BLOCK. A mismatch with the configured target is BLOCK. A missing or non-exact server target is HTTP 503.
- The signature bytes are UTF-8 `thoughtproof.sentinel.mandate.v1`, one 0x00 byte, then UTF-8 JCS of the envelope without `signature`. There is no fallback to unprefixed JCS.
- An unknown kid, once the store has answered, is BLOCK. A store that does not answer, including a load that stays silent past its deadline, is UNCERTAIN / HTTP 503.
- `principal_kid` is not written to a public archive by this stage.
- Pinning, rotation, and revocation are done only by the verified account owner or an explicitly authorized account admin, through a separate admin process. The pilot is a documented manual process. Until that process is in place, `registerPrincipalKey` stays locked: it rejects every attempt and it does not write. The agent, the verify API key, and `X-Sentinel-Agent-Id` are not that authority.

**Offline tests.** Fixtures for active, retired, revoked, unknown, and not-yet-valid windows, with a fake receipt clock. A registration call authenticated only as the verify caller or only by `X-Sentinel-Agent-Id` is rejected. A request-body `key_manifest` is not read as the principal manifest. No network and no live key generation beyond a test fixture keypair held in the test file.

**Paid-suite trigger paths.** No, on the same condition as stage 2: the module and the registration entry point stay outside the six paths. A handler placed under `src/engine/**` would start the suite.

**Separate GOs.** An implementation GO for the manifest shape and the status rules. Who may pin a key is decided: the verified account owner or an explicitly authorized account admin, through a separate admin process, piloted as a documented manual process. That process is not this stage. `registerPrincipalKey` stays locked until it exists. The verify-path GO is neither of those. No suite GO while the files stay off the trigger list.

## Stage 4 prerequisites — normalization, key mapping, no-auth

**Status.** Specified and implemented off the request path (2026-10-28). Not a wiring GO. Nothing in this section is called from `POST /sentinel/verify`.

**Goal.** Give stage 4 one mandate normalization, a proof of how existing keys become account ids (including rotation), and an explicit fail-closed rule when no authenticated account exists. Shipping the modules does not wire them.

### Shared mandate normalization

Module: `src/mandate-normalize.ts`. Tests: `src/mandate-normalize.test.ts`.

The signer, the authorization gate, and the P1 digest use this object, not `normalizeMandate` in `src/validation.ts`. That function rewrites aliases and drops fields. This one does not drop a field to make an object valid. JCS runs on the normalized object only. It does not decide which fields exist. The contract version `sentinel.mandate.normalized.v1` is not a field of the canonical object.

A bound concrete action is a plain object `action` whose `kind` is `informational`, `value_transfer`, `permission`, or `deploy_ship`. `unknown` is not concrete.

- `{}` is BLOCK `empty`.
- No `action` is BLOCK `action_missing`.
- An `action` that is not that shape is BLOCK `action_not_concrete`.
- `value_transfer` requires a finite `amount` ≥ 0, a non-empty `asset`, and a non-empty `recipient`.
- `permission` requires `allowance` (a finite number ≥ 0, or a non-empty string). The string is kept as written. It is not lowercased.
- `informational` and `deploy_ship` are kind only. Any other action field is BLOCK `unknown_field`, not stripped.
- Top-level keys are `kind`, `granted`, and `action` only. `kind`, when sent, must equal `action.kind` (BLOCK `kind_mismatch`). The canonical object always carries that `kind`.
- `granted` is optional. When present it is a non-empty object of `maxAmount`, `asset`, `recipient`, and `allowUnlimited`.

Aliases `maxAmountUsd` and `max_amount` become `maxAmount`. Aliases `amountUsd` and `amount_usd` become `amount`. The same value on the alias and the canonical name keeps one field. Two different values are BLOCK `alias_conflict`. Strings keep their original code units.

`__proto__`, `constructor`, and `prototype` are BLOCK `prototype_key`. The normalized object is built by assigning known keys on a fresh object. A non-plain prototype is the same BLOCK.

Size limits are BLOCK `too_large`: the original text and the canonical JSON are at most 8192 UTF-8 bytes, and each object has at most 16 keys. A string field over 512 UTF-8 bytes is BLOCK `malformed`. A further object inside `granted` or `action` is BLOCK `malformed`. The walk is one pass over the keys and one pass over the original text.

Offsets are UTF-16 indexes into that original text, the same indexes `String.prototype.indexOf` uses on that text. They are not indexes into a lowercased copy. Unicode case folding can expand a character (U+0130) and move a cut. A key is found by the scan, so the word `action` inside a string value is not the `action` key.

Unknown input and malformed types are BLOCK. The result type has no ALLOW. `ok: true` means a concrete normalized mandate exists. It is not a verdict and it does not authorize execution. A failed normalization is known-invalid, so the combined verdict is BLOCK even when the gate verdict is ALLOW or UNCERTAIN, and even when the signature verified. An existing BLOCK stays BLOCK. When normalization succeeds, ALLOW stays ALLOW and UNCERTAIN stays UNCERTAIN. Passing `signatureVerified: true` does not change the function's result.

Stage 3 still accepts a signed `{}` as `principal_signed`, because stage 3 does not apply this check. That success is not a bound action. Stage 4 must sign and verify `canonicalJson` from this module, not the pre-normalization object. This prerequisite does not change `principalMandateSignedBytes`.

### Key to account, rotation, wrong account

Module: `src/mandate-account-migration.ts`. Tests: `src/mandate-account-migration.test.ts`.

`migrateApiKeyToAccount` is `resolveServerAccountId`. The account id is the explicit account field on `SENTINEL_API_KEYS` (`key:platform:agent_id:account_id`). A pre-account record (`key:platform:agent_id`) is HTTP 503 `ACCOUNT_UNAVAILABLE`. The agent id is not the account id. A body account id and `X-Sentinel-Agent-Id` are not the account id. A key that is no longer in the list is HTTP 503. That is not BLOCK `retired` and not a principal-signed success.

Principal-key rotation is the manifest, not the API-key string. A replacement kid can be `active` while the old kid is `retired`. A new authorization with the retired kid is BLOCK `retired`. `historicalPrincipalVerification` is a different result: `purpose: 'historical'`, `authorizesExecution: false`, verdict BLOCK `historical_not_authorization`, whether or not the signature matched and whether the key status is `active`, `retired`, or `revoked`. It is not `mandate_source: principal_signed`. `verdictFromHistoricalVerification` never returns ALLOW. An existing BLOCK stays BLOCK. UNCERTAIN stays UNCERTAIN. A gate ALLOW becomes BLOCK on this path, because this path does not authorize execution.

Wrong account uses the stage-3 checks:

- The manifest document's `accountId` differs from the authenticated account: HTTP 503 `MANIFEST_MALFORMED`. The load key stays the authenticated account.
- The proof's `account_id` differs: BLOCK `account_mismatch`. The other account is not loaded.

`registerPrincipalKey` stays locked (`REGISTRATION_UNAUTHORIZED`, no write). These stage-3 rules stay as they are: `notBefore <= now < notAfter` (`notAfter` exclusive), environment exactly `production`, `preview`, or `development`, a 2 second store deadline, and signature bytes UTF-8 `thoughtproof.sentinel.mandate.v1`, one 0x00 byte, then UTF-8 JCS. A signer-chosen `iat` does not widen the key window.

### No authenticated account

Module: `src/mandate-no-auth.ts`. Tests: `src/mandate-no-auth.test.ts`.

When `SENTINEL_AUTH_REQUIRED` is not exactly `true`, `validateApiKey` returns `{ valid: true }` and no account id. It does not invent one from `SENTINEL_API_KEYS`. A key record with no account field also leaves `accountId` unset. `resolveServerAccountId` is then HTTP 503 `ACCOUNT_UNAVAILABLE`. A failed key check stays `valid: false` (HTTP 401 on the handler today). This prerequisite does not turn that into ALLOW.

`decideNoAuthMandatePath` is the mandate-path result for a missing account id, including a blank one. It returns HTTP 503 `ACCOUNT_UNAVAILABLE` with `applies: true`. It does not read the proof, the signature, or the normalizer: a present `mandate_proof`, a verified signature, and a concrete action all stay 503. The result is not `caller_declared` and not ALLOW. `verdictWithPrincipalCheck` maps that 503 to UNCERTAIN. An existing BLOCK stays BLOCK.

If an account id is already present, `applies` is false and `authorizesExecution` is false. That result is not a verdict. The caller still runs normalization and the principal check. It is not an ALLOW.

503 and BLOCK are different classes (`stage4FailureClass`):

| Situation | Class | Result |
|---|---|---|
| No authenticated account | unverifiable | HTTP 503 `ACCOUNT_UNAVAILABLE`. Not BLOCK. |
| Manifest `accountId` mismatch | unverifiable | HTTP 503 `MANIFEST_MALFORMED` |
| Manifest store does not answer | unverifiable | HTTP 503 `MANIFEST_UNAVAILABLE` |
| Replay store does not answer | unverifiable | HTTP 503 `REPLAY_STORE_UNAVAILABLE` |
| `{}`, missing `action` | known-invalid | BLOCK `empty` or `action_missing` |
| Proof `account_id` mismatch | known-invalid | BLOCK `account_mismatch` |
| Retired kid on a new authorization | known-invalid | BLOCK `retired` |
| Historical verification | known-invalid, not an execution | BLOCK `historical_not_authorization` |

A bad signature, a revoked kid, and an expired or replayed proof stay BLOCK on the stage-3 and stage-2 checks. None of these rows is ALLOW. A valid signature does not move a row.

**Paid-suite trigger paths.** No. The modules are `src/mandate-normalize.ts`, `src/mandate-account-migration.ts`, and `src/mandate-no-auth.ts`, plus their tests. They are outside the six paths. This section does not edit `src/engine/**`, the scenario file, the suite script, either helper under `scripts/lib/`, or the workflow file.

**Separate GOs.** A later implementation GO is still required before any of these functions is called from the verify handler, before `caller_declared` is recorded, and before any account is protected.

## Stage 4 — Request-path wiring

**Goal.** `caller_declared` is only an explicitly established legacy status. Once protection is enabled, a signature is required even when `mandate_proof` is omitted. An explicitly sent `mandate_proof` is always verified or rejected. The nonce is consumed before any side effect.

**Files and modules likely touched.**

- `api/sentinel/verify.ts`. Today the order is auth, model-config check, rate limit, `x402Gate`, `validateVerifyRequest`, then `verify()` from `src/engine/index.ts`, then evidence, optional attestation, `recordBillingEvent`, and signed export. Consumption has to move in front of the paid and other side-effecting steps: `x402Gate`, the engine call, attestation, and billing.
- `src/validation.ts` and `src/types.ts` for an optional `mandate_proof` object. Optional in the schema does not override an account policy that requires it.
- `src/canonical-verdict.ts` and `src/canonical-export.ts` to set `mandate_source` on the v2 body only. v1 bytes stay unchanged. A v2 build or sign failure still omits `signed_export_v2` only.
- `src/openapi-docs.ts` to document the optional object and `mandate_source`. The MCP `verify_before_action` schema is not in this repository.

**Invariants.** All global invariants, plus:

- Shipping the code does not enable protection and does not establish a legacy status. `caller_declared` applies only where that status was explicitly recorded. Missing or unreadable account or policy data is HTTP 503, never a downgrade of a protected account and never an implicit `caller_declared`.
- With protection on, an omitted `mandate_proof` is a known-invalid proof: BLOCK, not `caller_declared`, and not ALLOW.
- An explicitly sent `mandate_proof` is verified or rejected, including when the account is explicitly legacy. It is never silently ignored.
- **Shared mandate validation is specified and still unwired.** `src/mandate-normalize.ts` rejects a correctly signed `{}` and a mandate without a concrete `action`. Stage 3 does not call it. Stage 4 does not close until the verify path uses that normalization for the signature, the gate, and the digest. The prerequisite section does not do that wiring.
- The atomic stage 2 step runs only after the signature and the account-id equality check have succeeded, and before `x402Gate`, `verify()`, attestation, and billing. A BLOCK or UNCERTAIN from that step returns before those calls.
- `mandate_proof.account_id` must equal the stage 1 account id. It does not select the account. A mismatch is BLOCK.
- `mandate_source: principal_signed` is set only for the mandate that verified.
- 401 and 429 keep their HTTP status. They are not reissued as ALLOW when a proof is present.
- An engine BLOCK stays BLOCK if a valid signature was also present.

**Offline tests.** Handler-level tests with the engine, the payment gate, attestation, and billing mocked so none of them perform I/O. No provider keys. Required cases: `iat == exp` rejected; `exp < iat` rejected; a valid window accepted by the pure time helper; expiry between validation and consumption is BLOCK under a fake clock; protection on and `mandate_proof` omitted is BLOCK and the mocks record no side-effect call; account-id mismatch is BLOCK; a valid signature on an input the gate would BLOCK does not become ALLOW; a thrown v2 issuance error omits `signed_export_v2` and leaves the verdict unchanged; store-down is UNCERTAIN or 503 and is not ALLOW; a missing or unreadable policy is HTTP 503 and is not `caller_declared`; an explicit `mandate_proof` on a legacy account is still verified or rejected. Handler mocks do not prove replay-store atomicity. That remains the stage 2 test of the actual storage operation. The paid suite is not the test for this stage.

**Paid-suite trigger paths.** Not on the intended cut. `api/sentinel/verify.ts`, `src/validation.ts`, `src/types.ts`, `src/canonical-verdict.ts`, `src/canonical-export.ts`, and `src/openapi-docs.ts` are outside the six paths. The engine stays behind the existing `verify()` call and is not edited. A PR that does edit `src/engine/**`, the scenario file, the suite script, either helper under `scripts/lib/`, or the workflow file does touch the trigger paths. That PR starts the suite and needs its own suite GO. This plan does not give that GO.

**Separate GOs.**

- An implementation GO for the wiring, limited to the files above.
- A separate per-account enablement GO before any explicitly legacy account becomes protected. The implementation GO does not include it. Lifting the signature requirement is another explicit authorization. It is not this enablement GO and not a rollback.
- A suite GO if and only if the PR changes a trigger path.
- A separate GO in the MCP repository before `verify_before_action` grows `mandate_proof`. This repository's OpenAPI edit does not change that tool.

## Rollout and rollback

**Rollout.** Stage 1 first. Stages 2 and 3 next, in either order or in parallel: the replay store and the manifest do not read each other, and neither is on the request path yet. Stage 4 last. Accounts with an explicitly established legacy status stay `caller_declared`. Shipping stage 4 does not establish that status and does not enable protection. Enable one account only after a separate enablement GO, and only after 1–3 are in place for that account, including local tests of the actual replay storage operation. Do not enable an account that has no server account id, no reachable replay store, or no pinned key.

**Rollback.** A technical rollback preserves protection.

1. Protected accounts stay protected. Their affected requests are temporarily rejected, or routed to a version that still protects. Deliberately lifting the signature requirement needs a separate explicit authorization. That lift is not part of a regular rollback.
2. Leave already-consumed nonces in the shared store until each one's `exp + skew`. Deleting them early would make a still-valid proof replayable. If the consume step cannot run, reject the request. Do not skip consumption and continue.
3. Freeze new registration if the registration path itself is rolling back. Do not drop a manifest while any account is still protected. The manifest stays available to the version that still protects.
4. Do not revert the stage 1 account id while any account is protected. Rolling the mapping back while equality checks still run would make every proof a mismatch or would tempt a fallback to `X-Sentinel-Agent-Id`. That fallback is not allowed.

A rollback never turns store, key, or policy failures into ALLOW. It must not weaken a BLOCK that was already decided.

## Open questions

These need their own answers before the stage that depends on them. Decided items are marked. The rest are still open.

- **Account-id source.** What store or config is the stable id once the env record is not enough? The prerequisite records the current mapping and does not close this. `key:platform:agent_id:account_id` resolves through `resolveServerAccountId`. A pre-account `key:platform:agent_id` is HTTP 503 `ACCOUNT_UNAVAILABLE`. The agent id is not copied. Principal-key rotation is separate: a retired kid is BLOCK for a new authorization, and historical verification does not authorize execution.
- **Replay backend.** Which shared store, and how is it kept distinct from the rate-limit Redis that is allowed to fall back to memory? Is the nonce scoped per account or global?
- **Registration authority (decided).** A key may be pinned, rotated, or revoked only by the verified account owner or an explicitly authorized account admin, and only through a separate admin process. The pilot is a documented manual process. The agent, the verify API key, and `X-Sentinel-Agent-Id` are not that authority. Until that process is in place, `registerPrincipalKey` stays locked and writes nothing.
- **Shared mandate validation (specified, not wired).** `src/mandate-normalize.ts` is the shared normalization. A correctly signed `{}`, or a mandate without a concrete `action`, is BLOCK, not a bound action. Unknown and malformed input is BLOCK, never ALLOW. Wiring it into the signer, the gate, the digest, and `POST /sentinel/verify` is still stage 4 and is not done. Stage 3 does not call it.
- **0x signature prefix (open).** `verifyEd25519` in `src/principal-key-manifest.ts` accepts 128 hex digits, or the same digits with a `0x` or `0X` prefix. Proposal: do not require the prefix. Keep accepting both forms. The prefix does not select an account and does not change a BLOCK or a 503 into ALLOW. Whether a stored receipt keeps the original text or the stripped hex is not decided here.
- **HTTP 503 on the stage-4 response (open).** Check results already carry `httpStatus: 503` and a `code` (`ACCOUNT_UNAVAILABLE`, `MANIFEST_UNAVAILABLE`, `MANIFEST_MALFORMED`, `TARGET_ENVIRONMENT_UNAVAILABLE`, `RECEIPT_TIME_UNUSABLE`, `REPLAY_STORE_UNAVAILABLE`). Proposal, matching `modelConfigUnavailablePayload` and `rateLimitUnavailablePayload`: status 503 and a body `{ error, code, request_id }` using that `code`, with no `verdict` field and no ALLOW. `verdictWithPrincipalCheck` maps the 503 result to UNCERTAIN, and an existing BLOCK stays BLOCK. Do not collapse 503 into BLOCK in the HTTP body. The wording of `error`, and whether `verdict: UNCERTAIN` is added beside `code`, are not decided here.
- **Policy store.** Where an explicitly established `caller_declared` or protected status is recorded, and who may flip it. The enablement GO depends on this. Unreadable policy data is already decided: HTTP 503, not `caller_declared`.
- **Rate-limit writes.** Auth must run before consumption so the account id exists. The rate limiter currently increments before `x402Gate`. Whether that increment is a side effect that must move after a successful consume is undecided. It must not be used as a replay fallback either way.
- **Receipt clock.** ADR-0023 uses server receipt time plus 30 seconds of skew. Whether every instance reads one clock, or each reads its own clock inside that skew, is undecided.
- **MCP schema.** The tool schema is outside this repository. How `verify_before_action` carries `mandate_proof` without letting the host become the principal is a separate change.
