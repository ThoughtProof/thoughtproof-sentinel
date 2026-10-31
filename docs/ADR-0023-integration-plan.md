# ADR-0023 integration plan

**Status:** Proposed (2026-10-27). Do not merge without Raul GO.
**Parent:** [ADR-0023](ADR-0023-principal-signed-mandate.md) (Proposed). This plan does not change that status.
**Decider:** Founder

This document is a plan. It is not an implementation GO, not a suite GO, and not a per-account enablement GO. Accepting it does not authorize wiring the modules named below into the request path.

**Prerequisite note (2026-10-28).** Shared mandate normalization, the key-to-account mapping, and the no-auth failure class are specified in [Stage 4 prerequisites](#stage-4-prerequisites--normalization-key-mapping-no-auth) and implemented off the request path. That note is not a stage-4 wiring GO, not an enablement GO, and not a suite GO. `registerPrincipalKey` stays locked. No account is enabled. The replay store is not enabled.

The manual pin, rotate, retire, and revoke steps are specified in [ADR-0023 key-pinning admin process](ADR-0023-key-pinning-admin-process.md). Founder review on 2026-10-28 confirmed that merging that document does not permit manual pinning, does not unlock `registerPrincipalKey`, does not wire verification, and does not enable an account.

The read-only key-to-account census, rotation overlap, revoked keys, and the no-key fail-closed rule are in the [key-to-account migration addendum](ADR-0023-key-account-migration-addendum.md). The only pin writer is `pinPrincipalKeyAsAdmin`. `registerPrincipalKey` stays locked. That addendum does not enable an account and does not set `SENTINEL_MANDATE_PROOF_ENFORCE`.

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
- Pinning, rotation, and revocation are done only by the verified account owner or an explicitly authorized account admin, through a separate admin process. The pilot procedure is the [key-pinning admin process](ADR-0023-key-pinning-admin-process.md). Documenting that procedure does not put it into force. `registerPrincipalKey` stays locked until a separate founder GO: it rejects every attempt and it does not write. The agent, the verify API key, and `X-Sentinel-Agent-Id` are not that authority.

**Offline tests.** Fixtures for active, retired, revoked, unknown, and not-yet-valid windows, with a fake receipt clock. A registration call authenticated only as the verify caller or only by `X-Sentinel-Agent-Id` is rejected. A request-body `key_manifest` is not read as the principal manifest. No network and no live key generation beyond a test fixture keypair held in the test file.

**Paid-suite trigger paths.** No, on the same condition as stage 2: the module and the registration entry point stay outside the six paths. A handler placed under `src/engine/**` would start the suite.

**Separate GOs.** An implementation GO for the manifest shape and the status rules. Who may pin a key is decided: the verified account owner or an explicitly authorized account admin, through a separate admin process. The pilot procedure is the [key-pinning admin process](ADR-0023-key-pinning-admin-process.md). That procedure is not this stage, and publishing it is not the founder GO that unlocks registration. `registerPrincipalKey` stays locked until that separate GO. The verify-path GO is neither of those. No suite GO while the files stay off the trigger list.

## Stage 4 prerequisites — normalization, key mapping, no-auth

**Status.** Specified and implemented off the request path (2026-10-28). Not a wiring GO. Nothing in this section is called from `POST /sentinel/verify`.

**Goal.** Give stage 4 one mandate normalization, a proof of how existing keys become account ids (including rotation), and an explicit fail-closed rule when no authenticated account exists. Shipping the modules does not wire them.

### Shared mandate normalization

Modules: `src/mandate-normalize.ts`, `src/mandate-proof-signature.ts`. Tests beside them.

The signer, the authorization gate, and the P1 digest use this object, not `normalizeMandate` in `src/validation.ts`. That function rewrites aliases and drops fields. This one does not drop a field to make an object valid. JCS runs on the normalized object only. It does not decide which fields exist. The contract version `sentinel.mandate.normalized.v1` is not a field of the canonical object.

A bound concrete action is a plain object `action` whose `kind` is `informational`, `value_transfer`, `permission`, or `deploy_ship`. `unknown` and any other kind are not concrete: BLOCK `action_not_concrete`. A missing required field is the same BLOCK. The normalizer does not decide whether a pair of kinds is admissible. That stays with the existing gates. Mandate `kind` and `action.kind` are stored separately. They are not required to be equal. `kind` is omitted from the canonical object when the caller did not send a supported kind. An unsupported mandate `kind` is BLOCK `malformed`.

Required fields (`ACTION_REQUIRED_FIELDS`):

| `action.kind` | Required | Roles |
|---|---|---|
| `value_transfer` | `amount`, `asset`, `recipient` | Finite `amount` ≥ 0. `asset` and `recipient` are trimmed identities. |
| `permission` | `allowance`, `asset`, `recipient` | `recipient` is the spender. `amount` is optional. |
| `informational` | `content`, `recipient` | What is sent, and who receives it. `recipient` stays required. It may be a uniquely determined channel, thread, or recipient group. It is never invented. |
| `deploy_ship` | `target`, `revision` | Deployment target and revision. |

`{}` is BLOCK `empty`. No `action` is BLOCK `action_missing`. A present identity, asset, spender, or recipient that is empty or whitespace-only is BLOCK `malformed`. The canonical value is the trimmed string. Case is not changed. `granted` is optional. When present it is a non-empty object, and any `asset` or `recipient` on it follows the same non-blank rule.

Allowance has one grammar. The canonical value is a string. A bounded allowance matches `/^(0|[1-9][0-9]*)$/`: a non-negative decimal integer, no sign, no whitespace, no exponent, no decimal point, and no leading zeros. `0` is allowed. A JSON number is accepted only when it is a safe integer ≥ 0, and it is stored as that decimal string (`1` becomes `"1"`). A decimal string that matches the grammar is kept character for character. It is not rewritten through `Number`. If `Number(value)` is not finite, the string is BLOCK `malformed`. That covers a 309-digit or 512-digit run of nines: the grammar matches, and the existing gate's `parseAllowance` returns null, so `unlimited_approval` would be skipped as `allowance_unparseable`. A still-finite huge integer, such as 300 nines or `2^256 - 1`, stays the original decimal text. The normalizer accepts it. The existing gate still treats that magnitude as unlimited (`unlimited_approval`) when the principal did not grant unlimited. Unlimited as a token is only the exact string `unlimited`. `MAX_UINT256`, `Unlimited`, `-1`, `01`, `1e2`, `1.0`, and `"not-an-allowance"` are BLOCK `malformed`. The normalizer does not leave an unparseable allowance for the gate to skip.

Aliases `maxAmountUsd` and `max_amount` become `maxAmount`. Aliases `amountUsd` and `amount_usd` become `amount`. The same value on the alias and the canonical name keeps one field. Two different values are BLOCK `alias_conflict`.

`__proto__`, `constructor`, and `prototype` are BLOCK `prototype_key`. The normalized object is built by assigning known keys on a fresh object. A non-plain prototype is the same BLOCK.

Size limits are BLOCK `too_large`: the original text and the canonical JSON are at most 8192 UTF-8 bytes, and each object has at most 16 keys. A string field over 512 UTF-8 bytes is BLOCK `malformed`. A further object inside `granted` or `action` is BLOCK `malformed`. The walk is one pass over the keys and one pass over the original text.

Offsets are UTF-16 indexes into that original text, the same indexes `String.prototype.indexOf` uses on that text. They are not indexes into a lowercased copy. Unicode case folding can expand a character (U+0130) and move a cut. A key is found by the scan, so the word `action` inside a string value is not the `action` key.

Unknown input and malformed types are BLOCK. The result type has no ALLOW. `ok: true` means a concrete normalized mandate exists. It is not a verdict and it does not authorize execution. A failed normalization is known-invalid, so the combined verdict is BLOCK even when the gate verdict is ALLOW or UNCERTAIN, and even when the signature verified. An existing BLOCK stays BLOCK. When normalization succeeds, ALLOW stays ALLOW and UNCERTAIN stays UNCERTAIN. Passing `signatureVerified: true` does not change the function's result.

Stage 3 still accepts a signed `{}` as `principal_signed`, because stage 3 does not apply this check. That success is not a bound action. Stage 4 must sign and verify `canonicalJson` from this module, not the pre-normalization object. This prerequisite does not change `principalMandateSignedBytes`.

**Legacy calls at wiring time.** A call that is explicitly classified as legacy, and that was not sent with `mandate_proof`, must not be run through this strict normalizer. `ok-04-fyi-aligned-cos-status` is that shape: a prose FYI with no structured `recipient`. Do not invent a recipient, a channel, or a thread so the call can pass. A protected account requires the full action binding. An explicitly sent `mandate_proof` requires it too, including on an account that is otherwise legacy. The normalizer is not applied to those legacy-without-proof calls, and it does not fill a missing `recipient`.

### Key to account, rotation, wrong account

Module: `src/mandate-account-migration.ts`. Tests: `src/mandate-account-migration.test.ts`.

`mapAuthenticatedPrincipalToAccount` reads the explicit account field on `SENTINEL_API_KEYS` (`key:platform:agent_id:account_id`). It takes a principal whose `authenticated` flag is already decided. HTTP 503 `ACCOUNT_UNAVAILABLE` is only when that flag is true, the key is still in the server record, and the record has no account id. That is the migration gap. An invalid key, a removed key, or `authenticated: false` does not get that 503. Those stay the auth layer's 401 (`validateApiKey` returns `valid: false`). The helper must not replace that decision. The agent id is not the account id. A body account id and `X-Sentinel-Agent-Id` are not the account id.

Principal-key rotation is the manifest, not the API-key string. A replacement kid can be `active` while the old kid is `retired`. A new authorization with the retired kid is BLOCK `retired`. `historicalPrincipalVerification` is a different result: `purpose: 'historical'`, `authorizesExecution: false`, verdict BLOCK `historical_not_authorization`, whether or not the signature matched and whether the key status is `active`, `retired`, or `revoked`. It is not `mandate_source: principal_signed`. `verdictFromHistoricalVerification` never returns ALLOW. An existing BLOCK stays BLOCK. UNCERTAIN stays UNCERTAIN. A gate ALLOW becomes BLOCK on this path, because this path does not authorize execution.

Wrong account uses the stage-3 checks:

- The manifest document's `accountId` differs from the authenticated account: HTTP 503 `MANIFEST_MALFORMED`. The load key stays the authenticated account.
- The proof's `account_id` differs: BLOCK `account_mismatch`. The other account is not loaded.

`registerPrincipalKey` stays locked (`REGISTRATION_UNAUTHORIZED`, no write). These stage-3 rules stay as they are: `notBefore <= now < notAfter` (`notAfter` exclusive), environment exactly `production`, `preview`, or `development`, a 2 second store deadline, and signature bytes UTF-8 `thoughtproof.sentinel.mandate.v1`, one 0x00 byte, then UTF-8 JCS. A signer-chosen `iat` does not widen the key window.

### No authenticated account

Module: `src/mandate-no-auth.ts`. Tests: `src/mandate-no-auth.test.ts`.

When `SENTINEL_AUTH_REQUIRED` is not exactly `true`, `validateApiKey` returns `{ valid: true }` and no account id. It does not invent one from `SENTINEL_API_KEYS`. A key record with no account field also leaves `accountId` unset. `resolveServerAccountId` is then HTTP 503 `ACCOUNT_UNAVAILABLE`. A failed key check stays `valid: false` (HTTP 401 on the handler today). This prerequisite does not turn that into ALLOW.

`decideNoAuthMandatePath` is the mandate-path result for a missing account id. A blank id and a whitespace-only id (`" "`, newlines, tabs) are missing: HTTP 503 `ACCOUNT_UNAVAILABLE` with `applies: true`. It does not read the proof, the signature, or the normalizer: a present `mandate_proof`, a verified signature, and a concrete action all stay 503. The result is not `caller_declared` and not ALLOW. `verdictWithPrincipalCheck` maps that 503 to UNCERTAIN. An existing BLOCK stays BLOCK.

`stage4UnavailablePayload` is the stage-4 HTTP 503 body: `{ error, code, request_id }`. `error` is the constant `Mandate verification unavailable`. There is no `verdict` field. `cause` and `mandate` are ignored, so an exception or the mandate plaintext is not copied into the body. BLOCK stays a separate result and is not this payload. The helper is not wired to a handler.

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

**Paid-suite trigger paths.** No. The modules are `src/mandate-normalize.ts`, `src/mandate-proof-signature.ts`, `src/mandate-account-migration.ts`, and `src/mandate-no-auth.ts`, plus their tests. They are outside the six paths. This section does not edit `src/engine/**`, the scenario file, the suite script, either helper under `scripts/lib/`, or the workflow file.

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
- **Shared mandate validation.** `src/mandate-normalize.ts` rejects a correctly signed `{}` and a mandate without a concrete `action`. Stage 3 does not call it. Draft #112, which is not a merge GO, applies the normalizer to protected accounts and to every explicitly sent `mandate_proof`, and passes that one normalized request to the engine and to F1. It does not apply the normalizer to an explicitly legacy call that omitted the proof, and it does not invent `informational.recipient`. Flag off keeps the existing request.
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
3. Freeze new registration if the registration path itself is rolling back. Do not drop a manifest while any account is still protected. The manifest stays available to the version that still protects. A rollback does not write an older manifest back. Any manifest change detects an intervening write by compare-and-set on the version or etag read before the change, and aborts on mismatch. `revoked` stays terminal for that kid: rotation and rollback do not undo it. If the store state is unclear, stop, escalate, re-read, and re-apply only a forward change.
4. Do not revert the stage 1 account id while any account is protected. Rolling the mapping back while equality checks still run would make every proof a mismatch or would tempt a fallback to `X-Sentinel-Agent-Id`. That fallback is not allowed.

A rollback never turns store, key, or policy failures into ALLOW. It must not weaken a BLOCK that was already decided. It must not replace the current manifest with an older copy, and it must not clear a `revoked` kid.

## Decisions from review of draft #112

**Status.** Recorded 2026-10-28 from Raul's review of draft PR #112. This record is not a merge GO, not an enablement GO, and not a suite GO. `registerPrincipalKey` stays locked. No account is enabled. No Vercel env change is authorized by this record.

- **AccountPolicyStore (decided).** An account's mandate policy lives in its own persistent admin-managed store, keyed by `(environment, accountId)`. The record is an explicit `legacy` or `protected` status plus a version used for compare-and-set. It is not derived from request fields. It has no TTL. Missing data is not an automatic legacy status. The backend adapter is a separate step. Until that adapter exists, an unreadable policy is HTTP 503 `POLICY_UNAVAILABLE`.
- **POLICY_UNAVAILABLE (decided).** Official stage-4 HTTP 503 code. It is distinct from a missing manifest (`MANIFEST_UNAVAILABLE`). The body is `{ error, code, request_id }` from `stage4UnavailablePayload`. `error` is `Mandate verification unavailable`. There is no `verdict`.
- **MANDATE_VERIFICATION_UNAVAILABLE (decided with the #112 fix).** Official stage-4 HTTP 503 code for an unexpected failure inside the mandate gate, including a thrown normalizer. It is not `MANIFEST_UNAVAILABLE`. The message stays the constant `Mandate verification unavailable`. The body does not include exception text.
- **Known-invalid versus unverifiable (decided).** A provably invalid proof is HTTP 200 with `verdict: BLOCK`. Technical unverifiability is HTTP 503 with no `verdict`. A valid proof whose policy is unreadable is HTTP 503, and the nonce is not consumed.
- **Flag on (decided for this draft).** Enforcement on does not mean every request is HTTP 503. A malformed or otherwise known-invalid proof is BLOCK first. With the current production placeholders (no policy store, no pinned manifest, no replay config, no target environment), no request reaches the engine: a known-invalid proof is BLOCK, and every other enforced request is 503.
- **Rate-limit increment (decided).** The rate-limit increment stays before nonce consumption. That increment is the explicit exception to "no side effect before nonce consumption." Payment (`x402Gate`), attestation, and billing stay after a successful consume. The rate-limit counter is not a replay fallback.
- **Time (decided).** Nonce consumption checks expiry atomically with Redis `TIME`. Other time checks use the instance clock. Before any account is enabled, the skew and the limits of those instance-clock checks must be tested and operationally controlled.
- **Replay store (decided).** Missing replay configuration is HTTP 503 `REPLAY_STORE_UNAVAILABLE`. The nonce key stays per account. Production and test environments need separate stores or namespaces.
- **Target environment (decided).** A missing server target is HTTP 503 `TARGET_ENVIRONMENT_UNAVAILABLE`. The target is not derived from the submitted proof.
- **MCP (decided out of scope).** `verify_before_action` stays outside this repository. This plan's OpenAPI text does not change that tool.

## Open questions

These need their own answers before the stage that depends on them. Decided items are marked. The rest are still open. The #112 review above closes the policy store, the 503-versus-BLOCK split, the rate-limit exception, the receipt clock, the replay-store availability rule, the target environment, and MCP scope. It does not close the account-id store beyond the env record, and it does not choose the policy backend adapter.

- **Account-id source.** What store or config is the stable id once the env record is not enough? The prerequisite records the current mapping and does not close this. For an already-authenticated key, `key:platform:agent_id:account_id` resolves through `mapAuthenticatedPrincipalToAccount`. A pre-account `key:platform:agent_id` is HTTP 503 `ACCOUNT_UNAVAILABLE` only after that key authenticated. An invalid or removed key stays 401 and the mapping helper does not replace it with 503. The agent id is not copied. Principal-key rotation is separate: a retired kid is BLOCK for a new authorization, and historical verification does not authorize execution.
- **Replay backend (decided for availability and scope).** The nonce key is per account. Missing configuration is HTTP 503 `REPLAY_STORE_UNAVAILABLE`. Production and test need separate stores or namespaces. The store stays distinct from the rate-limit Redis that may fall back to memory.
- **Registration authority (decided).** A key may be pinned, rotated, or revoked only by the verified account owner or an explicitly authorized account admin, and only through a separate admin process. The pilot steps are the [key-pinning admin process](ADR-0023-key-pinning-admin-process.md). The agent, the verify API key, and `X-Sentinel-Agent-Id` are not that authority. Founder review on 2026-10-28 confirmed that merging those steps does not permit manual pinning, unlocking `registerPrincipalKey`, wiring, or account enablement. `registerPrincipalKey` stays locked and writes nothing. The draft admin writer is `pinPrincipalKeyAsAdmin`, which is not an HTTP route and is not called from `POST /sentinel/verify`. Shipping it does not enable an account. Operational questions inside that process that were not decided in the review are still open.
- **Shared mandate validation (wired in draft #112, not a merge GO).** `src/mandate-normalize.ts` is the shared normalization. A correctly signed `{}`, or a mandate without a concrete `action`, is BLOCK, not a bound action. Unknown and malformed input is BLOCK, never ALLOW. Draft #112 calls it for a protected account and for every explicit `mandate_proof`, and the F1 package digest is computed from that same normalized request the engine receives. An explicitly legacy call that omits the proof does not go through it. Stage 3 does not call it. Flag off leaves the legacy request unchanged.
- **Signature transport (confirmed).** Stage-4 `mandate_proof.signature` is exactly 128 lowercase hex characters, `/^[0-9a-f]{128}$/`. No `0x` prefix, no uppercase, no whitespace, no other length. Anything else is BLOCK `malformed_signature` from `parseMandateProofSignature`. Domain separation stays `thoughtproof.sentinel.mandate.v1`, one 0x00 byte, then UTF-8 JCS. That separator protects the signed content. The hex prefix is not part of it. Stage 3's `verifyEd25519` still accepts an optional `0x` / `0X` prefix and uppercase hex. That parser is not the stage-4 transport check, and this prerequisite does not change it. Draft #112 applies that strict check on the request path before signature verification. That draft is not a merge GO. A matching signature text does not by itself ALLOW.
- **Separate kinds (confirmed).** Mandate `kind` and `action.kind` are stored separately. The normalizer does not require them to be equal. Admissibility of a pair, including a `value_transfer` mandate with an amount-bounded `permission` action, stays with the existing gates.
- **Whitespace account id (confirmed).** `authenticatedAccountId` that is empty or only whitespace is no account. `decideNoAuthMandatePath` returns HTTP 503 `ACCOUNT_UNAVAILABLE`. It does not treat `" "` as an account.
- **HTTP 503 on the stage-4 response (confirmed, extended by the #112 review).** Status 503 and a body `{ error, code, request_id }` from `stage4UnavailablePayload`. `error` is `Mandate verification unavailable`. `code` is one of `ACCOUNT_UNAVAILABLE`, `MANIFEST_UNAVAILABLE`, `MANIFEST_MALFORMED`, `TARGET_ENVIRONMENT_UNAVAILABLE`, `RECEIPT_TIME_UNUSABLE`, `REPLAY_STORE_UNAVAILABLE`, `POLICY_UNAVAILABLE`, or `MANDATE_VERIFICATION_UNAVAILABLE`. There is no `verdict` field. The body does not include an exception or the mandate. A provably invalid proof is HTTP 200 `verdict: BLOCK`, not this payload. `verdictWithPrincipalCheck` still maps a 503 result object to UNCERTAIN, and an existing BLOCK stays BLOCK.
- **Legacy without proof (confirmed).** At wiring time, an explicitly legacy call that omits `mandate_proof` is not passed through the strict normalizer. `ok-04-fyi-aligned-cos-status` has no structured recipient. Do not invent one. Protected accounts and explicitly sent proofs require the full action binding, including `informational.recipient`.
- **Policy store (decided).** See [Decisions from review of draft #112](#decisions-from-review-of-draft-112). `AccountPolicyStore` is the persistent admin-managed record. Unreadable policy data is HTTP 503 `POLICY_UNAVAILABLE`, not `caller_declared`.
- **Rate-limit writes (decided).** Auth still runs before consumption so the account id exists. The rate-limit increment stays before nonce consumption and is the explicit exception to "no side effect before nonce consumption." It is not a replay fallback. Payment, attestation, and billing stay after a successful consume.
- **Receipt clock (decided).** Nonce consumption uses Redis `TIME` inside the atomic consume. Other checks use instance time. Their skew and limits are tested and operationally controlled before enablement.
- **MCP schema (out of scope).** The tool schema stays outside this repository. How `verify_before_action` carries `mandate_proof` is not this change.
