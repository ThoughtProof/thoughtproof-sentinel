# ADR-0023 integration plan

**Status:** Proposed (2026-10-27). Do not merge without Raul GO.
**Parent:** [ADR-0023](ADR-0023-principal-signed-mandate.md) (Proposed). This plan does not change that status.
**Decider:** Founder

This document is a plan. It is not an implementation GO, not a suite GO, and not a per-account enablement GO. It changes no code, no request path, and no workflow. Accepting it does not authorize editing the modules named below.

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
- A missing mapping stays missing. It is not filled from the request, and a request with no account id cannot be treated as a protected account.
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
- The atomic step re-checks `exp > now - 30` against server time and inserts the nonce together. If the proof has expired, the step does not consume it and the result is BLOCK, never ALLOW.
- If the store does not answer, the result is UNCERTAIN / HTTP 503. There is no in-memory pass and no retry of the same proof from the start.
- A consumed nonce is retained at least until `exp + skew`. An entry that disappears earlier is a failed test, not an accepted replay.
- The time rules from ADR-0023 still apply, including `exp > iat`. A zero-length window is BLOCK before the store is asked to spend a nonce.

**Offline tests.** A fake clock and an in-test double of the store. No network. Cover: first consume succeeds; the same nonce consumed again is BLOCK; `exp` equal to `now - 30` at the consume instant is BLOCK and leaves no spent nonce; a store error is UNCERTAIN and writes nothing locally; an entry is still present at `exp + skew`; `checkWindowThenConsume` is asserted not to be the consuming call (it has no nonce argument and no store).

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
- `active` means receipt time `now` is inside `notBefore` / `notAfter`. A signer-chosen `iat` does not widen that window.
- `retired` is BLOCK for a new authorization request. `revoked` is BLOCK, including inside any old window.
- An unknown kid, once the store has answered, is BLOCK. A store that does not answer is UNCERTAIN / HTTP 503.
- `principal_kid` is not written to a public archive by this stage.

**Offline tests.** Fixtures for active, retired, revoked, unknown, and not-yet-valid windows, with a fake receipt clock. A registration call authenticated only as the verify caller or only by `X-Sentinel-Agent-Id` is rejected. A request-body `key_manifest` is not read as the principal manifest. No network and no live key generation beyond a test fixture keypair held in the test file.

**Paid-suite trigger paths.** No, on the same condition as stage 2: the module and the registration entry point stay outside the six paths. A handler placed under `src/engine/**` would start the suite.

**Separate GOs.** An implementation GO for the manifest shape and the status rules, and a distinct registration GO for who may pin a key and how they prove they are the principal for that account. The verify-path GO is not either of those. No suite GO while the files stay off the trigger list.

## Stage 4 — Request-path wiring

**Goal.** Per-account policy defaults to `caller_declared`. Once protection is enabled, a signature is required even when `mandate_proof` is omitted. The nonce is consumed before any side effect.

**Files and modules likely touched.**

- `api/sentinel/verify.ts`. Today the order is auth, model-config check, rate limit, `x402Gate`, `validateVerifyRequest`, then `verify()` from `src/engine/index.ts`, then evidence, optional attestation, `recordBillingEvent`, and signed export. Consumption has to move in front of the paid and other side-effecting steps: `x402Gate`, the engine call, attestation, and billing.
- `src/validation.ts` and `src/types.ts` for an optional `mandate_proof` object. Optional in the schema does not override an account policy that requires it.
- `src/canonical-verdict.ts` and `src/canonical-export.ts` to set `mandate_source` on the v2 body only. v1 bytes stay unchanged. A v2 build or sign failure still omits `signed_export_v2` only.
- `src/openapi-docs.ts` to document the optional object and `mandate_source`. The MCP `verify_before_action` schema is not in this repository.

**Invariants.** All global invariants, plus:

- Default policy remains `caller_declared`. Shipping the code does not enable protection.
- With protection on, an omitted `mandate_proof` is a known-invalid proof: BLOCK, not `caller_declared`, and not ALLOW.
- The atomic stage 2 step runs only after the signature and the account-id equality check have succeeded, and before `x402Gate`, `verify()`, attestation, and billing. A BLOCK or UNCERTAIN from that step returns before those calls.
- `mandate_proof.account_id` must equal the stage 1 account id. It does not select the account. A mismatch is BLOCK.
- `mandate_source: principal_signed` is set only for the mandate that verified.
- 401 and 429 keep their HTTP status. They are not reissued as ALLOW when a proof is present.
- An engine BLOCK stays BLOCK if a valid signature was also present.

**Offline tests.** Handler-level tests with the engine, the payment gate, attestation, and billing mocked so none of them perform I/O. No provider keys. Required cases: `iat == exp` rejected; `exp < iat` rejected; a valid window accepted by the pure time helper; expiry between validation and consumption is BLOCK under a fake clock; protection on and `mandate_proof` omitted is BLOCK and the mocks record no side-effect call; account-id mismatch is BLOCK; a valid signature on an input the gate would BLOCK does not become ALLOW; a thrown v2 issuance error omits `signed_export_v2` and leaves the verdict unchanged; store-down is UNCERTAIN or 503 and is not ALLOW. The paid suite is not the test for this stage.

**Paid-suite trigger paths.** Not on the intended cut. `api/sentinel/verify.ts`, `src/validation.ts`, `src/types.ts`, `src/canonical-verdict.ts`, `src/canonical-export.ts`, and `src/openapi-docs.ts` are outside the six paths. The engine stays behind the existing `verify()` call and is not edited. A PR that does edit `src/engine/**`, the scenario file, the suite script, either helper under `scripts/lib/`, or the workflow file does touch the trigger paths. That PR starts the suite and needs its own suite GO. This plan does not give that GO.

**Separate GOs.**

- An implementation GO for the wiring, limited to the files above.
- A separate per-account enablement GO before any account leaves `caller_declared`. The implementation GO does not include it.
- A suite GO if and only if the PR changes a trigger path.
- A separate GO in the MCP repository before `verify_before_action` grows `mandate_proof`. This repository's OpenAPI edit does not change that tool.

## Rollout and rollback

**Rollout.** Stage 1 first. Stages 2 and 3 next, in either order or in parallel: the replay store and the manifest do not read each other, and neither is on the request path yet. Stage 4 last, with policy still `caller_declared` for every account. Enable one account only after a separate enablement GO, and only after 1–3 are in place for that account. Do not enable an account that has no server account id, no reachable replay store, or no pinned key.

**Rollback.** Reverse the enablement before removing code.

1. Set every protected account back to `caller_declared`. New requests then stop requiring a proof. Do this before any other rollback step.
2. Stop calling the consume step from the handler. Leave already-consumed nonces in the shared store until each one's `exp + skew`. Deleting them early would make a still-valid proof replayable.
3. Freeze registration. Do not drop a manifest while any account is still protected. After step 1, the manifest is unused by verify and can stay in place until a later GO removes it.
4. Revert the stage 1 account id only after no account is protected and stage 4 is off. Rolling the mapping back while equality checks still run would make every proof a mismatch or would tempt a fallback to `X-Sentinel-Agent-Id`. That fallback is not allowed.

A rollback must not weaken a BLOCK that was already decided, and it must not turn a store outage into ALLOW.

## Open questions

These need their own answers before the stage that depends on them. This plan does not decide them.

- **Account-id source.** `SENTINEL_API_KEYS` has no account-id field today. What store or config is the stable id, and what happens to keys that predate it?
- **Replay backend.** Which shared store, and how is it kept distinct from the rate-limit Redis that is allowed to fall back to memory? Is the nonce scoped per account or global?
- **Registration authority.** Who may pin, rotate, or revoke a key, and what proof binds that person to the stage 1 account? The agent and the API key are not the answer. The exact process is still open.
- **Policy store.** Where the per-account `caller_declared` / protected bit lives, and who may flip it. The enablement GO depends on this.
- **Rate-limit writes.** Auth must run before consumption so the account id exists. The rate limiter currently increments before `x402Gate`. Whether that increment is a side effect that must move after a successful consume is undecided. It must not be used as a replay fallback either way.
- **Receipt clock.** ADR-0023 uses server receipt time plus 30 seconds of skew. Whether every instance reads one clock, or each reads its own clock inside that skew, is undecided.
- **MCP schema.** The tool schema is outside this repository. How `verify_before_action` carries `mandate_proof` without letting the host become the principal is a separate change.
