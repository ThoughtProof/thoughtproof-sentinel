# ADR-0024: Principal delegation certificate

**Status:** Proposed (2026-11-01). Do not merge without founder GO.
**Decider:** Founder
**Amends:** [ADR-0023](ADR-0023-principal-signed-mandate.md) (Proposed), only where that ADR defers delegation. This document does not change ADR-0023's status.
**Depends on:** ADR-0023 envelope, replay, and pinned-manifest rules; [key-pinning admin process](ADR-0023-key-pinning-admin-process.md) (Proposed); [integration plan](ADR-0023-integration-plan.md) (Proposed).

This ADR records a proposed amendment. It implies no implementation GO, no suite GO, no account-enablement GO, and no change to `SENTINEL_MANDATE_PROOF_ENFORCE`. It does not change the API, the engine, the verifier, the replay script, the manifest, the admin pin function, or any workflow. The certificate shape, the verifier order, and the rollout stages below are prerequisites for later owner GOs. They are not those GOs.

Accepting this amendment does not delete ADR-0023. A signature over `granted` alone stays forbidden. Extra keys kept for rotation stay not-delegation. The admin-process non-goal that bars delegation on the pin path stays in force until a separate owner GO for certificate issuance.

## What this amendment changes

ADR-0023 decision 1 defers delegation and keeps rotation keys distinct from it (lines 23–24):

> Delegation comes later, and only when it is explicit and scoped. Extra keys kept for rotation are not delegation. The model, the MCP host, and the API key are callers. They may submit bytes. They do not become the principal by calling `verify`.

ADR-0023 decision 5 says a signature over `granted` alone would be a standing mandate and would need its own rules for usage, total budget, and delegation, and that those rules are out of scope (lines 37–39):

> The signature covers one concrete action: the full, uniquely normalized mandate, including `action`, in the versioned form below. Signing only `granted` would be a reusable standing mandate and would need its own rules for usage, total budget, and delegation. That is out of scope here.

ADR-0023 non-goals repeat the prohibition (lines 182–188), including line 188: "No standing mandate over `granted` alone." The [key-pinning admin process](ADR-0023-key-pinning-admin-process.md) non-goals say the same for that procedure (line 334): "No standing mandate, no delegation, and no historical-verification path on a new authorization."

This ADR is the later, explicit, scoped delegation those sentences point at. It supplies usage limits, an optional aggregate budget, and a certificate lifetime. It does not authorize a bearer document that spends by itself, and it does not authorize signing `granted` without `action`.

## Problem

Under ADR-0023, a `protected` account must present a principal-signed `mandate_proof` on every verify call. `evaluateMandateRequestPath` in `src/mandate-request-path.ts` returns BLOCK `mandate_proof_required` when the policy is `protected` and the body has no `mandate_proof` (lines 314–317). The proof is single-use. Its window is at most 300 seconds (`exp - iat <= 300`, `exp > iat`), with at most 30 seconds of skew. Those numbers are product decisions in `src/mandate-proof-window.ts` (`MANDATE_PROOF_SKEW_SECONDS`, `MANDATE_PROOF_MAX_WINDOW_SECONDS`, lines 8–12) and again in `src/mandate-replay-store.ts` (`MANDATE_REPLAY_SKEW_SECONDS`, `MANDATE_REPLAY_MAX_WINDOW_SECONDS`, lines 22–26). The atomic consume script bakes both numbers in. A caller cannot pass an argument that widens them (`MANDATE_REPLAY_CONSUME_SCRIPT`, lines 36–84).

The principal key is an offline Ed25519 key. The motivating case is account `acct_grokbot` and principal kid `a35203aa6d07`: a person who holds that private key cannot sign a fresh proof for every action the agent takes. This ADR does not pin that kid, does not write a manifest for that account, and does not enable the account. The names are the problem statement only.

The model, the MCP host, and the verify API key remain callers. Putting the agent key into the principal manifest as another rotation kid would make the agent the principal. ADR-0023 decision 1 forbids that reading.

## Decision

The principal signs a scoped, expiring delegation certificate. The certificate authorizes one separate agent Ed25519 key to sign `mandate_proof` objects inside the certificate's scope until the certificate expires or is revoked. The agent then signs today's single-use `mandate_proof`. The proof's nonce, 300-second window, domain, and replay consumption stay as they are. The principal private key stays offline. Sentinel never receives it. The agent cannot sign a certificate. A certificate signed by the agent key does not verify under the pinned principal kid.

The certificate is a second signature over a scope. It is not a signature over `granted`, and it is not itself a mandate. Each verify still carries one concrete normalized `action`. The certificate says which future actions the agent key may sign, and within what ceilings.

### Certificate fields

The signed certificate is a plain object. `signature` is not a field of the object that is canonicalized. JCS is the same canonicalization ADR-0023 already uses (`canonicalize` in `src/principal-key-manifest.ts`). There is no unprefixed-JCS fallback.

| Field | Role |
|---|---|
| `schema_version` | `sentinel.delegation.v1`. |
| `cert_id` | Opaque issuer-chosen id. Unique among certificates for the account. Not a nonce and not reused after revocation. |
| `account_id` | Must equal the authenticated account id. It does not select the account. |
| `environment` | Exactly `production`, `preview`, or `development`, the same three tokens as `PRINCIPAL_ENVIRONMENTS`. |
| `principal_kid` | Kid of the pinned principal key that signs the certificate. |
| `agent_kid` | Kid of the agent key. A different public key is a different `agent_kid`. |
| `agent_key` | Public JWK only: `kty: OKP`, `crv: Ed25519`, `x`, and `kid`. `kid` equals `agent_kid`. No private field. |
| `allowed_kinds` | Non-empty subset of the concrete kinds in `src/mandate-normalize.ts`: `informational`, `value_transfer`, `permission`, `deploy_ship`. |
| `ceilings` | Per-action constraints on the normalized `action` (amount or allowance, asset, recipient). A listed kind with no ceiling is a malformed certificate. |
| `aggregate` | Optional. When present, one integer budget for one named asset over the life of the certificate. When absent, no aggregate counter is incremented. |
| `notBefore`, `notAfter` | Strict RFC3339 UTC with second resolution, the same grammar as principal-key bounds. Both required. `notAfter` is exclusive. The span has a maximum. The working figure is 31 × 86400 seconds. Confirming that figure is an open question. |

The principal's signing string is domain-separated and is not the mandate domain, the export domain, or the pin-possession domain:

```
signed_input =
  UTF-8("thoughtproof.sentinel.delegation.v1")
  || 0x00
  || UTF-8(JCS(certificate))
```

`thoughtproof.sentinel.mandate.v1`, `thoughtproof.sentinel.export.v1`, and `thoughtproof.sentinel.principal-key-pin.v1` do not verify as a certificate. A signature over the JCS alone does not verify.

The certificate travels as an additive object, `delegation_certificate`, beside `mandate` and `mandate_proof`. It is not a field of the mandate-proof envelope. Adding it there would change `principalMandateSignedBytes`.

Placeholder example only. These values are not a vector and not a key.

```json
{
  "schema_version": "sentinel.delegation.v1",
  "cert_id": "placeholder-cert",
  "account_id": "placeholder-account",
  "environment": "production",
  "principal_kid": "placeholder-principal-kid",
  "agent_kid": "placeholder-agent-kid",
  "agent_key": {
    "kty": "OKP",
    "crv": "Ed25519",
    "x": "placeholder-agent-public-key",
    "kid": "placeholder-agent-kid"
  },
  "allowed_kinds": ["value_transfer"],
  "ceilings": {
    "value_transfer": {
      "max_amount": "10",
      "asset": "PLACEHOLDER_ASSET",
      "recipients": ["placeholder-recipient"]
    }
  },
  "aggregate": {
    "asset": "PLACEHOLDER_ASSET",
    "max_amount": "100"
  },
  "notBefore": "2026-11-01T00:00:00Z",
  "notAfter": "2026-12-02T00:00:00Z"
}
```

### What stays unchanged about `mandate_proof`

The agent signs the envelope ADR-0023 already specifies. `src/principal-key-manifest.ts` builds those bytes in `principalMandateSignedBytes` (lines 249–274): UTF-8 `thoughtproof.sentinel.mandate.v1`, one 0x00 byte, then UTF-8 JCS of `schema_version`, the normalized mandate, `nonce`, `iat`, `exp`, `principal_kid`, `account_id`, `environment`, and `purpose`. `signature` stays out of that JCS. Schema version stays `sentinel.mandate-proof.v1`. Purpose stays `action_authorization`.

`principal_kid` on the proof remains the pinned principal kid named on the certificate. It does not become `agent_kid`. The agent public key is taken from the certificate. The proof signature is that agent key's Ed25519 signature over the unchanged signed input.

`verifyPrincipalMandate` (lines 517–590) is unchanged. It still verifies the proof signature against the manifest public key for `principal_kid`, after `checkMandateProofTimes`. A delegation certificate is not a manifest entry. An agent signature presented on the direct path fails closed as BLOCK `signature_invalid`. Wiring a second path is a later stage and a separate owner GO.

The time rules stay the product decisions already in code:

- `exp > iat`
- `exp - iat <= 300`
- `iat <= now + 30` and `exp > now - 30` at receipt
- the consume step re-checks expiry against Redis `TIME` inside `MANDATE_REPLAY_CONSUME_SCRIPT` before the nonce is spent
- a consumed nonce is retained at least until `exp + skew`
- a lost consume response is not retried from the start

`checkWindowThenConsume` in `src/mandate-proof-window.ts` (lines 83–96) still does not consume a nonce. A successful return from it is not consumption and is not an aggregate increment.

### Scope check

The scope check reads the normalized `action` from `normalizeMandate` (`src/mandate-normalize.ts`), the same object the signer and the gate see. It does not read `granted` as the thing being authorized. `granted` may still be present on the mandate. A certificate that matches `granted` and does not match `action` fails the scope check.

For a `value_transfer` action the ceiling constrains `amount`, `asset`, and `recipient`. `amount` must be less than or equal to the ceiling. `asset` must equal the ceiling's asset. `recipient` must equal one recipient listed on the ceiling. Comparison uses the canonical trimmed values. Case is unchanged. There is no wildcard and no prefix match.

For a `permission` action the ceiling constrains `allowance`, `asset`, and `recipient` (the spender). The allowance must be a canonical bounded integer string (`CANONICAL_ALLOWANCE_PATTERN`). The exact token `unlimited` (`CANONICAL_UNLIMITED_ALLOWANCE`) is outside every ceiling in this ADR. An action whose allowance is `unlimited` is BLOCK.

A kind that is not in `allowed_kinds` is BLOCK. A listed kind whose ceiling is missing is a malformed certificate and is BLOCK. `informational` and `deploy_ship` may appear in `allowed_kinds` only after the open question on their ceiling fields is closed. Until then, issuance of a certificate that lists either kind is `malformed_request`, and a verify that presents one is BLOCK.

Account and environment are scope. The certificate `account_id` must equal the authenticated account. The certificate `environment` must equal the proof `environment` and the trusted server target injected beside the check. The proof does not supply that target. A mismatch is BLOCK. A missing or non-exact server target stays HTTP 503, as in `verifyPrincipalMandate` (lines 538–546).

Certificate time uses the principal-key rule, not the proof skew. `notBefore <= now < notAfter`. The 30-second proof skew does not move either bound. A signer-chosen `iat` on the proof does not widen the certificate.

### Verifier order

When a certificate is presented, the delegation verifier runs in this order. A later step does not run after a known-invalid failure. A store that does not answer stops the sequence with HTTP 503.

1. **Agent signature.** Verify the `mandate_proof` signature against `agent_key` in the presented certificate, over the unchanged mandate signing string. Failure is BLOCK.
2. **Certificate signature.** Verify the certificate under the pinned manifest key for `principal_kid`, over the delegation signing string. The manifest is the server-pinned document for the authenticated account (`PrincipalKeyManifest` in `src/principal-key-manifest.ts`). A caller-supplied `key_manifest` or JWKS URL is not that document. Failure is BLOCK. A manifest store that does not answer is HTTP 503 `MANIFEST_UNAVAILABLE`. A malformed manifest is HTTP 503 `MANIFEST_MALFORMED`.
3. **Scope.** The normalized action, the account, the environment, and the certificate window must sit inside the certificate. Failure is BLOCK.
4. **Revocation.** `cert_id` is not revoked. `principal_kid` is not revoked and is not retired. `keyFailureAtReceipt` already returns `revoked` before the key window (lines 468–472). The delegation path applies that result and the certificate-status result before the atomic consume. A revoked or retired principal kid is BLOCK even when the certificate window is still open. A revocation store that does not answer is HTTP 503.
5. **Atomic consume.** One Redis `EVAL` consumes the nonce and, when `aggregate` is present, increments that certificate's counter only if the result is still within the cap. The cap comparison and the increment are inside the same script. Failure of the script's checks is BLOCK. Failure of the store is HTTP 503.

A verified delegation is a precondition. It may set `mandate_source` to `principal_signed` for the mandate that verified, which is the statement Sentinel already makes on the direct path. It does not return ALLOW. `verdictAfterVerifiedMandate` still folds the gate verdict with `verdictWithPrincipalCheck` (lines 360–373 of `src/mandate-request-path.ts`): BLOCK stays BLOCK, UNCERTAIN stays UNCERTAIN, and a failed check does not become ALLOW.

Enforcement stays behind `mandateProofEnforceEnabled`: `SENTINEL_MANDATE_PROOF_ENFORCE` must be exactly `true` (`src/mandate-request-path.ts`, lines 1–7 and 65–68). This ADR does not set that variable. The default request deps still report policy `unreadable` (line 77). An unreadable policy on a protected account stays HTTP 503. It is not `caller_declared`.

### Atomic Redis operation

The current script only consumes a nonce. This ADR does not edit it. A later implementation GO may add a new script beside it. That script must keep the current time checks and the current refusal to take a caller-supplied skew or window. Redis `TIME` remains the clock for the proof. The client remains the dedicated replay client (`retry` with `retries: 0`, no shared rate-limit fallback, no in-memory store). `consumeMandateNonce` (lines 234–278) already maps a missing client, a throw, a deadline miss (`MANDATE_REPLAY_DEADLINE_MS` is 2000 ms), or a reply it cannot parse to HTTP 503 `REPLAY_STORE_UNAVAILABLE`.

The new script's visible outcome is one of these, and nothing partial:

- Success: the nonce is consumed once, and, when the certificate has an aggregate budget, the counter has increased by the action's integer amount and the stored total is less than or equal to the cap.
- Known-invalid (BLOCK): expired or not-yet-valid proof, window longer than 300 seconds, non-positive window, replay, revoked `cert_id`, revoked principal-kid marker, certificate time window closed against Redis `TIME`, or aggregate cap exceeded. The nonce is not newly consumed. The counter does not increase. A replay of an already-consumed nonce does not increase the counter.
- Store failure (HTTP 503): the client is missing, the call throws, the deadline passes, or the reply is not one of the script's results. The caller does not retry that proof. The caller does not decrement the counter to compensate for a timeout. A timeout is not evidence that the script failed to commit, and it is not ALLOW.

The certificate window re-check inside the script uses Redis `TIME` and does not apply the 30-second proof skew. An earlier check in the Node process does not satisfy it. The proof-window re-check inside the script stays the one ADR-0023 already requires (`exp > now - 30`).

When `aggregate` is omitted, the script consumes the nonce and does not write a counter. Per-action ceilings still apply in the scope check before the script runs. Omitted aggregate is not an unlimited budget. There is no second counter for "number of calls" unless a later owner GO adds one. This draft has one optional amount counter.

The amount added to the counter is an integer in the one asset named on `aggregate`. The normalized action `amount` is a JavaScript number and may be fractional (`readAliasNumber` in `src/mandate-normalize.ts`). Encoding a fractional amount, or an amount in another asset, into that integer is an open question. Until it is closed, a certificate that sets `aggregate` accepts only an action whose amount is a non-negative integer in that asset. Any other amount or asset is BLOCK and does not call the script.

The replay Redis used here is not the rate-limit Redis that may fall back to memory. It is the store stage 2 of the integration plan already isolates.

### Revocation, read-back, and audit

Certificate issuance and certificate revocation are account actions outside `POST /sentinel/verify`. They use the same admin constraints as a pin, a rotation, a retirement, and a revocation in the [key-pinning admin process](ADR-0023-key-pinning-admin-process.md). `registerPrincipalKey` stays locked (`REGISTRATION_UNAUTHORIZED`, no write). `pinPrincipalKeyAsAdmin` is not the certificate writer. The verify API key and `X-Sentinel-Agent-Id` are not authority. The agent cannot register its key or its certificate.

This draft proposes an allowlist, on the pattern of `unknown_kid`. The principal signature is required. A `cert_id` that the certificate store has never recorded is BLOCK once that store has answered, including when the signature verifies. A store that does not answer is HTTP 503, including when the signature would have verified. Confirming the allowlist against a signature-only denylist is an open question. Until that question is closed, no certificate is issued.

Issuance writes the certificate document for the authenticated account with status `active`, by compare-and-set against the store version or etag just read. The version or etag is store metadata. It is not a field of the certificate. Scope, `agent_key`, `x`, `notBefore`, and `notAfter` are not edited in place. A different scope or a different agent key is a new `cert_id`. `revoked` is terminal for that `cert_id`. A later write leaves it `revoked` and does not delete it. There is no step that restores a previous certificate document.

Revoking the principal kid uses the existing emergency and ordinary revocation rules. `revoked` is BLOCK for every new authorization, including inside the kid window and including inside any certificate window that names that kid. Revocation does not automatically stop approvals already issued or actions already running. The same sentence in the admin process (emergency revocation, lines 265–271) applies to a revoked `cert_id`.

Read-back matches the admin process (lines 226–240). The second operator reads with the same load shape the verifier uses. A load that stays silent past 2000 milliseconds (`PRINCIPAL_MANIFEST_LOAD_DEADLINE_MS`) is no answer. Acceptance of an issuance is all of the following:

1. The load answered, and the document parses under the certificate rules.
2. The store key and the document `account_id` both equal the request account.
3. The new `cert_id` appears once, with status `active`, and with `agent_key`, `agent_kid`, `principal_kid`, ceilings, aggregate (or its absence), `notBefore`, and `notAfter` equal to the request.
4. The document contains no private-key field and no field the parser would reject.
5. Both operators name the same environment token, and that token is the server target of the store that answered.
6. Every already `revoked` `cert_id` on the document is still `revoked`.

A revocation read-back shows that `cert_id` as `revoked` and shows no other status change. A read-back that fails is `readback_failed`. The operator does not write the previous document back. If the store state is unclear, the operator stops, escalates, re-reads, and applies only a forward change. A successful read-back is not ALLOW, does not set `mandate_source`, and is not a call to `POST /sentinel/verify`.

The 15-minute figure in the admin process stays an internal target for a confirmed read-back of an emergency revocation. It is not a grace period before the write and not a period in which verify still accepts the certificate. A binding SLA remains dependent on a named on-call and a fixed store, which the admin process already records as not given.

The evidence record and the audit log stay split as in the admin process (lines 46–75).

The evidence record is internal. It may hold the opaque request id, the requester role, `accountId`, environment, `cert_id`, `principal_kid`, `agent_kid`, the public `x`, the ceilings, the aggregate cap or its absence, `notBefore`, `notAfter`, the channel and time of out-of-band confirmation, both operator ids, and the outcome. It does not hold a private key, a seed, a field named `d`, an API key, a signature, or a nonce.

The audit log entry is status and counts only:

| Field | Content |
|---|---|
| `action` | `cert_issue`, `cert_revoke`, or `cert_emergency_revoke`. Principal-kid actions keep their existing names. |
| `environment` | `production`, `preview`, or `development`. |
| `result` | `accepted`, `rejected`, `failed`, or `indeterminate` on a lost write response. |
| `reason` | Present only when the result is not `accepted`. The admin-process reason set applies, plus `scope_invalid` and `duplicate_cert`. |
| `certs_before`, `certs_after` | Integer counts of certificates on the document, from a read that answered. |
| `active_after`, `revoked_after` | Integer counts by status after the attempt. `state_unclear` omits counts. |

The audit entry does not include `accountId`, `cert_id`, `principal_kid`, `agent_kid`, `x`, a signature, a nonce, an API key, or the ceiling bodies. `principal_kid` and `agent_kid` are not publicly archived. A lost write response does not reuse the pre-write counts.

Each store call and the audit call keeps its own monotonic 2000 ms deadline, as `pinPrincipalKeyAsAdmin` already does. A response that arrives after the deadline is ignored. The result is HTTP 503. `authorizesExecution` on an issuance result is false.

For the atomic script to see a revocation without a separate earlier read, an accepted `cert_revoke`, `cert_emergency_revoke`, or principal-kid `revoke` / `emergency_revoke` also writes a revocation marker that the script reads inside the same `EVAL` as the nonce and the counter. The marker write is part of acceptance. If the marker write and the document write disagree, the result is `state_unclear`, the audit omits counts, and the operator does not report success. Which physical store holds the certificate document is the still-open manifest-store question in the integration plan. This ADR does not choose it.

## Threat model

**Stolen agent key.** The attacker can sign `mandate_proof` objects until the certificate is revoked or expires, and only inside the remaining per-action ceilings and the remaining aggregate cap. They cannot raise the cap, extend `notAfter`, change the recipient list, or mint a new certificate. Revocation of `cert_id` stops the next verify once the revocation marker is visible to the script. Actions already approved are not recalled. The principal key is not on the agent host, so stealing the agent key does not steal the principal key.

**Stolen certificate.** The certificate contains the agent public key and the scope. It does not contain the agent private key. A copy of the certificate does not produce a valid `mandate_proof` signature. A substituted `agent_key` breaks the principal's certificate signature.

**Stolen principal key.** The attacker can sign new certificates. Under the proposed allowlist they still need an operator to record the new `cert_id` before verify will accept it. Emergency revocation of the principal kid blocks new authorizations that name that kid, on the direct path and on the delegation path. The open question on allowlist versus denylist is the size of the window before that revocation.

**Races.** Two parallel verifies with the same nonce must not both pass. That remains `SET NX` inside the script. Two parallel verifies with different nonces against one aggregate cap must not both pass when only one increment fits. The comparison and the increment are in the same `EVAL`. A check in the Node process before the call does not satisfy either race. A revocation that lands after a Node-side status read and before the script runs is closed by reading the marker inside the script. A timeout after the script may have committed stays HTTP 503 for that caller, leaves the nonce consumed if it committed, and is not retried and not reversed.

**Clock skew.** Proof skew stays 30 seconds and applies only to `iat` and `exp` on `mandate_proof`. Certificate bounds and principal-key bounds ignore that skew. The script's clock is Redis `TIME`. A caller-supplied clock does not enter the script. The Node receipt clock is not the consume clock.

**Principal key stays offline.** The principal signs the certificate on a machine that does not host the agent. The agent signs day-to-day proofs with the agent key. Sentinel stores the principal public key and the certificate, including the agent public key. Sentinel does not store either private key. A verify call does not collect a fresh principal signature.

## Non-goals

- No widening of the `mandate_proof` window. `MANDATE_PROOF_MAX_WINDOW_SECONDS` and `MANDATE_REPLAY_MAX_WINDOW_SECONDS` stay 300. Skew stays 30. The script does not grow a parameter that changes either number.
- No bearer standing mandate. The certificate does not authorize an action by being presented alone. A verify without a single-use `mandate_proof` still fails on a `protected` account.
- No signature over `granted` alone. ADR-0023 lines 39 and 188 stay in force.
- No auto-renewal. A certificate does not mint its successor. A new interval is a new `cert_id` and a new offline principal signature.
- No implementation, no suite run, and no account enablement under this ADR.
- No change to `SENTINEL_MANDATE_PROOF_ENFORCE` or any other environment variable.
- No edit to `MANDATE_REPLAY_CONSUME_SCRIPT`, `verifyPrincipalMandate`, `registerPrincipalKey`, or `pinPrincipalKeyAsAdmin` under this ADR.
- No agent-registered key, and no use of an extra manifest kid as a substitute for a certificate.
- No caller-supplied principal manifest and no caller-supplied JWKS URL.
- No use of the certificate as a promotion input, and no change to v1 bytes.
- No public archive of `principal_kid`, `agent_kid`, or `cert_id`.
- No paid-suite run. This ADR does not touch the `pull_request` path filter in `.github/workflows/action-authorization-suite.yml`.

## Rollout

Each stage needs its own owner GO. A GO for one stage does not authorize the next. No stage flips `SENTINEL_MANDATE_PROOF_ENFORCE`. No stage enables an account. No stage edits the paid-suite trigger paths (`scenarios/action-authorization-suite.json`, `scripts/action-authorization-suite.mjs`, `scripts/lib/action-auth-suite-metrics.mjs`, `scripts/lib/action-auth-suite-receipt.mjs`, `.github/workflows/action-authorization-suite.yml`, `src/engine/**`).

1. **Offline certificate vectors.** Pure checks for the delegation signing string, a wrong principal key, a swapped agent key, a tampered ceiling, an over-long window, and a domain separator that does not verify as a mandate, an export, a pin possession, or unprefixed JCS. No store and no request path.
2. **Issuance and revocation admin path.** Compare-and-set, read-back, evidence record, and audit counts. Not an HTTP route on verify. Not `registerPrincipalKey`. Does not choose the manifest store if that question is still open. No certificate is issued while the store is unset.
3. **Atomic script.** A new script that consumes the nonce and applies the aggregate cap and the revocation markers inside one `EVAL`, with local tests against the real command and concurrent requests. No request-path wiring. The existing consume script stays in place until this stage's GO says otherwise, and even then the 300-second window and the 30-second skew stay.
4. **Request-path wiring.** A delegation branch in front of the existing gates, still only when `SENTINEL_MANDATE_PROOF_ENFORCE` is exactly `true`, and only for an account whose server-side policy is `protected`. A separate per-account enablement GO names the account. The direct principal-signed path remains for proofs that carry no certificate.

Shipping stages 1–3 does not authorize stage 4. Stage 4 does not authorize setting the enforce flag. The flag's current meaning, including "exactly `true`" and the default-off behavior in `mandateProofEnforceEnabled`, is unchanged.

## Invariants

1. A valid agent signature plus a valid certificate never upgrades a verdict to ALLOW.
2. Known-invalid certificates and proofs are BLOCK. A store that does not answer is HTTP 503. Neither is `caller_declared`, and neither permits execution.
3. UNCERTAIN, evaluator error, HTTP 5xx, 401, and 429 never become ALLOW because a certificate was present.
4. An existing BLOCK is never weakened, including to UNCERTAIN.
5. The mandate-proof window stays at most 300 seconds. The certificate lifetime does not extend a proof.
6. The principal private key is not an input to verify, to the replay store, or to the audit log.
7. A certificate presented without a single-use proof does not authorize a `protected` account.

## Open questions

None of these authorizes a write, a flag change, or a suite run. The decisions above are not reopened by being adjacent to this list.

1. **Allowlist versus denylist.** Proposed: a `cert_id` the store has not recorded is BLOCK once the store has answered, on the same pattern as `unknown_kid` in `verifyPrincipalMandate`. The alternative is a signature-only denylist: any certificate that verifies under the pinned principal kid is active until its `cert_id` is revoked. The denylist widens the window in which a stolen principal key can authorize a new agent key. Confirm the allowlist before any issuance GO.
2. **Certificate lifetime.** Proposed maximum span is 31 × 86400 seconds, both bounds required, `notAfter` exclusive, strict RFC3339 UTC. The 31-day figure is a working example, not a confirmed product number. Confirm or replace it. A pilot may choose a shorter span. A longer span needs this question closed with a new number.
3. **Aggregate integer encoding.** The counter is an integer in one asset. Normalized `amount` may be fractional, and assets have different decimal scales. Proposed until this is closed: reject any non-integer amount, and reject any asset other than the budget asset, with BLOCK, and do not call the script. No silent scaling.
4. **Ceilings for `informational` and `deploy_ship`.** Amount, asset, and recipient do not describe those kinds. Proposed: a certificate that lists either kind is not issuable (`malformed_request`) until the ceiling fields for `content`, `recipient`, `target`, and `revision` are decided. `value_transfer` and bounded `permission` are the kinds this draft can express.
5. **Recipient list size.** Proposed: exact equality against one or more recipients on the ceiling, case-sensitive, no wildcard. Confirm whether the pilot is exactly one recipient.
6. **One agent key, one active certificate.** Proposed: an account may hold more than one active certificate, so a replacement can exist before the old one is revoked. The same agent public key on two active certificates is rejected at issuance. Confirm. The proof envelope does not gain a `cert_id` field, so the presented certificate is what the verifier scopes.
7. **Fresh holder confirmation.** Proposed: `cert_issue` needs the same fresh holder out-of-band confirmation as `pin` and `rotate`. `cert_revoke` may proceed on the admin's registry grant plus admin out-of-band confirmation, matching `retire` and `revoke`. An operator who suspects the agent key is exposed may file `cert_emergency_revoke`, and the suspicion and the operator id go into the evidence record.
8. **Marker store and the unchosen manifest store.** The script's revocation markers and the aggregate counter live in the replay Redis. The certificate document's store is still the open manifest-store question in the integration plan. Confirm that both the document write and the marker write are required before a revocation or an issuance is `accepted`, and that a divergence is `state_unclear`.
9. **Field name on the request.** Proposed: `delegation_certificate` beside `mandate` and `mandate_proof`. Confirm the name before any schema or OpenAPI change. This ADR does not make that change.
10. **Direct path and delegation path together.** Proposed: a request with no `delegation_certificate` stays on `verifyPrincipalMandate` unchanged. A request with a certificate uses the delegation order in this ADR and does not also accept a principal signature over the same proof as a second signature. Confirm that a proof is not required to carry both signatures.
