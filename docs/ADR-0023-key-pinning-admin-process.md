# ADR-0023 key-pinning admin process

**Status:** Proposed (2026-10-28). Founder review the same day recorded the decisions below. Do not merge without Raul GO. Do not execute a pin from this document.
**Parent:** [ADR-0023](ADR-0023-principal-signed-mandate.md) (Proposed). [Integration plan](ADR-0023-integration-plan.md) (Proposed). This document does not change either status.
**Decider:** Founder

This is the pilot manual process for pinning, rotating, retiring, and revoking a principal Ed25519 public key. It is consistent with the manifest rules in `src/principal-key-manifest.ts` and with the stage-4 prerequisite notes. It changes no code, no test, no workflow, and no request path.

**Decided (founder review, 2026-10-28).** Merging this document does not permit manual pinning, does not unlock `registerPrincipalKey`, does not wire `verifyPrincipalMandate` into `POST /sentinel/verify`, and does not enable any account. `registerPrincipalKey` still returns `{ ok: false, httpStatus: 503, code: 'REGISTRATION_UNAUTHORIZED' }` and writes nothing. A later founder GO has to name this document and explicitly authorize the first pin, or explicitly authorize a change to that function, before anyone follows the execution steps below.

Placeholder strings in the examples are not keys, not signatures, and not vectors.

## Who

Two roles, and they are not the same person acting as both sides of the check.

| Role | What they may do |
|---|---|
| Verified account holder | Request a pin, rotation, retirement, or revocation for the one account the server record names. |
| Explicitly authorized account admin | Request the same actions for that account, after a prior holder authorization record exists. |
| ThoughtProof operator | Execute the accepted request by writing the manifest document to the store. Two operators complete the check. |

The holder is the person or organization whose resources the account stands for, as in ADR-0023 decision 1. On ThoughtProof's own account, that is the legitimate ThoughtProof responsible. On a customer account, that is the customer. An intermediary account is not enough. The model, the MCP host, the agent, the verify API key, and `X-Sentinel-Agent-Id` are callers. They are not the holder, not the admin, and not the operator.

The public API is not the execution path. `POST /sentinel/verify` is not the execution path. `registerPrincipalKey` is not the execution path. The operator uses a separate admin process: direct access to the manifest store for one environment, after the checks in this document.

## Identity and admin authorization

The pilot registry is a founder-maintained record, created before any pin request. For each `accountId` it names the confirming person and one out-of-band channel that was established before the request (a phone number or a video identity already on the record). It also lists any account admin: the person, the `accountId`, and which actions the holder has authorized (`pin`, `rotate`, `retire`, `revoke`). Adding or changing a registry row is a two-person founder action. A pin request cannot create the row it relies on.

### Holder

1. The request arrives on a channel that is not the registry channel.
2. An operator reaches the confirming person on the registry channel. A reply in the request thread is not out-of-band confirmation. The request channel alone is not confirmation.
3. On that second channel the holder confirms, character for character: `accountId`, environment, `kid`, the public-key `x`, `notBefore`, `notAfter`, and the intended scope. The holder does not send a private key, a seed, or an API key.
4. Two ThoughtProof operators, independently, match that confirmation to the request. Both must agree before a write. The requester does not complete either side of this check. On ThoughtProof's own account, the holder may be an operator; a second operator who did not file the request still has to agree, and a third operator performs the other side, so the requester is never the sole checker.

### Account admin

An admin request is accepted only when the registry already names that admin for that `accountId` and for that action. A claim that arrives with the request is not the authorization record.

For the pilot, `pin` and `rotate` still need a fresh holder confirmation on the registry channel, even when an authorized admin files the request. `retire` and `revoke` may be confirmed out-of-band with the admin alone, because those actions only remove authority. Whether a standing admin grant may pin or rotate without a fresh holder confirmation is an open question below. Until the founder decides it, the fresh holder confirmation stands.

### Evidence record

The evidence record is internal and access-controlled. It is not a public archive of `principal_kid`. It is not the audit log line. Operators record:

- opaque request id
- requester role: `holder` or `account_admin`
- `accountId`, environment, `kid`, `notBefore`, `notAfter`, intended-scope text
- the public `x` that was confirmed (a public key, not a secret)
- channel type and the UTC time of out-of-band confirmation
- operator ids of both checkers and the UTC time each agreed
- for an admin request, the id of the prior registry authorization
- the possession-check result (`verified` or `failed`) and the domain string that was used
- outcome: `accepted`, `rejected`, or `failed`

The evidence record does not contain a private key, a seed, a field named `d`, an API key, a signature, or the challenge nonce. A request that arrives with any private-key field is rejected. Those bytes are not copied into the record, the ticket, or the audit log.

## Audit log

The audit log entry is status and counts only. The operator-supplied fields are:

| Field | Content |
|---|---|
| `action` | `pin`, `rotate_add`, `retire`, `revoke`, or `emergency_revoke` |
| `environment` | `production`, `preview`, or `development` |
| `result` | `accepted`, `rejected`, or `failed` |
| `reason` | Present only when the result is not `accepted`. One of `identity_unconfirmed`, `admin_unauthorized`, `possession_failed`, `window_invalid`, `environment_mismatch`, `account_unmapped`, `private_key_present`, `malformed_request`, `store_unavailable`, `readback_failed`, `version_mismatch`, `state_unclear`. |
| `keys_before`, `keys_after` | Integer counts of keys on the document, taken from a read that answered. |
| `active_after`, `retired_after`, `revoked_after` | Integer counts by status after the attempt. On a reject or a failed write that changed nothing, and where a fresh read answered, the after-counts equal the before-counts from that read. A `state_unclear` entry omits counts. It does not copy them from a stale read. |

The log system may add its own event id and timestamp. The entry does not include `accountId`, `kid`, `x`, a signature, a nonce, an API key, or any private key. Counts and statuses are not a substitute for the evidence record. The evidence record cites the log event id.

## Request

The operator accepts a request only when every item below is present and passes. There is no partial pin.

### Account

`accountId` is the authenticated account only. The operator reads it from the server-side key record (`key:platform:agent_id:account_id`) for that account. The value on the request must equal that field character for character. The request does not select an account. A body field, an agent id, or `X-Sentinel-Agent-Id` is not the account id.

An empty or whitespace-only account id on the record is no account (HTTP 503 `ACCOUNT_UNAVAILABLE` on the verify path). The operator rejects the request with `account_unmapped` and does not invent an id. An invalid or removed API credential stays the auth layer's 401. This process does not turn that into a pin, and it does not copy the credential into the request.

### Key id and public key

`kid` is a non-empty string, with no leading or trailing ASCII whitespace, unique among keys already on that account's manifest. A `kid` is not reused later for a different `x`.

The holder generates the Ed25519 key pair and holds the private key. Sentinel stores the public key only. The stored form is the JWK-shaped object the manifest parser accepts:

| Field | Rule |
|---|---|
| `kty` | `OKP` |
| `crv` | `Ed25519` |
| `x` | Raw 32-byte public key, unpadded base64url, exactly 43 characters matching `/^[A-Za-z0-9_-]{43}$/`, decoding to 32 bytes and re-encoding to the same string. |
| `kid` | The request `kid`. |
| `alg` | Omitted, or exactly `EdDSA`. Any other algorithm is rejected. |
| `status` | `active` on a new pin. |
| `notBefore`, `notAfter` | The request bounds, as strings. |

The verifier builds its own SPKI key from `x`. The request does not carry SPKI, PEM, a hex public key, a `0x` prefix, or base64 with padding. Those forms are `malformed_request`. Private fields (`d`, `k`, `priv`, `private`, `privateKey`, `private_key`, `seed`) are `private_key_present` and are not stored.

`x` is not the export JWKS at `/.well-known/thoughtproof-keys.json` and not a caller-supplied F1 `key_manifest`. A `jwks` or `jwks_url` field on the request is rejected.

### Environment

`environment` is exactly `production`, `preview`, or `development`. Comparison is exact: no trim, no case fold, no other token. It must be the trusted server target of the store the operator will write. The manifest document has no environment field. `parseManifest` rejects a document with any top-level field other than `accountId` and `keys`, and any key field outside the set above, so the operator must not copy `environment` onto the document.

A later mandate proof carries its own `environment` and is compared with the server target injected beside the check. A proof value outside the three tokens is BLOCK `environment_rejected`. A mismatch with the server target is BLOCK `environment_mismatch`. A missing or non-exact server target is HTTP 503 `TARGET_ENVIRONMENT_UNAVAILABLE`. This process does not set that server target.

### Window

`notBefore` and `notAfter` are both required. Each is strict RFC3339 UTC with second resolution: `YYYY-MM-DDTHH:MM:SSZ`. No fraction, no numeric offset. The text must round-trip through the calendar. A date that `Date.parse` would normalize, including `2026-02-30T00:00:00Z`, `2026-02-29T00:00:00Z` in a non-leap year, `2026-04-31T00:00:00Z`, and `2026-01-01T24:00:00Z`, is `window_invalid`.

At the UTC time the operators record for acceptance:

- `notBefore <= now < notAfter`
- `notAfter > notBefore` (equal bounds are invalid; the verifier reports HTTP 503 `MANIFEST_MALFORMED`)

`notAfter` is exclusive. The 30-second mandate-proof skew does not widen this window. A null bound is an open side in the verifier. The pilot request does not use null. Both bounds are concrete timestamps.

### Intended scope

Intended scope is free text on the request and in the evidence record. It states what the holder means the key to stand for. For the pilot the only accepted scope is: this key may be presented as `principal_kid` for `purpose: action_authorization` on this `accountId` in this environment.

Scope is not a field on the manifest. The verifier does not read it. A pin is not a standing mandate over `granted` alone, not a delegation, and not an export or evidence key. Extra keys for rotation are not delegation.

## Proof of possession

The holder proves they control the private key that matches `x`. The operator checks that signature offline, before any write. A failed check is `possession_failed`. Nothing is written. The public verify API is not used as the checker.

**Decided (founder review, 2026-10-28).** The possession domain is separate from the mandate domain:

```
signed_input =
  UTF-8("thoughtproof.sentinel.principal-key-pin.v1")
  || 0x00
  || UTF-8(JCS(challenge))
```

`signature` is not a field of `challenge`. One 0x00 byte separates the domain from the JCS. JCS is RFC 8785, the same canonicalization the mandate path uses. The signer and the operator sign and verify those bytes, not a pretty-printed JSON document.

Proof of possession proves control of the key. It does not authorize the account. Account authorization is the independent identity check above: the registry channel and the two-person match. A valid possession signature does not permit a pin, a write, or an enablement.

The mandate domain stays `thoughtproof.sentinel.mandate.v1`. The export domain stays `thoughtproof.sentinel.export.v1`. A signature over either of those domains, or over unprefixed JCS, is not possession for this process. `verifyPrincipalMandate` accepts only the mandate domain, so a signature under the pin domain does not verify as a mandate.

`challenge` fields:

| Field | Rule |
|---|---|
| `schema_version` | `sentinel.principal-key-pin.v1` |
| `purpose` | `principal_key_pin` |
| `account_id` | The same account id as the request `accountId`. The signed name is `account_id`. The stored manifest name is `accountId`. |
| `environment` | The request environment, exact. |
| `kid` | The request `kid`. |
| `x` | The request `x`. |
| `not_before`, `not_after` | The request bounds. The signed names use underscores. The stored names are `notBefore` and `notAfter`. |
| `challenge_nonce` | Single-use value from a CSPRNG, issued by the operator. |
| `iat`, `exp` | Unix seconds. |

Proposed time rule, the same numbers ADR-0023 already fixed for mandate proofs: `exp > iat`, `exp - iat <= 300`, `iat <= now + 30`, `exp > now - 30`. The operator issues the challenge. The holder returns the signature inside that window. A stale or reused challenge nonce is `possession_failed`.

The signature text is exactly 128 lowercase hex characters, `/^[0-9a-f]{128}$/`. No `0x` prefix, no uppercase, no whitespace, no other length. That is the stage-4 transport rule for `mandate_proof.signature`. Stage 3's `verifyEd25519` still accepts an optional `0x` / `0X` prefix and uppercase hex. This admin check does not use that looser parser, and this document does not change it.

Placeholder only. These values are not a key and not a signature.

```json
{
  "schema_version": "sentinel.principal-key-pin.v1",
  "purpose": "principal_key_pin",
  "account_id": "placeholder-account",
  "environment": "production",
  "kid": "placeholder-kid",
  "x": "placeholder-public-key",
  "not_before": "2026-10-28T00:00:00Z",
  "not_after": "2027-10-28T00:00:00Z",
  "challenge_nonce": "placeholder-nonce",
  "iat": 1780000000,
  "exp": 1780000300,
  "signature": "placeholder-signature"
}
```

The operator removes `signature` before JCS. The remaining object is the challenge.

The domain string above is decided. The challenge field names, `schema_version`, and `purpose` in the table are still an open question. A possession signature under the decided domain still does not authorize a store write. A write waits for a separate founder GO. Merging this document does not give that GO.

## Execution

After both operators agree, one operator writes one manifest document to the manifest store. The store key is the authenticated `accountId`. The document repeats that id. The write is not an HTTP call to this service.

```json
{
  "accountId": "placeholder-account",
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "alg": "EdDSA",
      "x": "placeholder-public-key",
      "kid": "placeholder-kid",
      "status": "active",
      "notBefore": "2026-10-28T00:00:00Z",
      "notAfter": "2027-10-28T00:00:00Z"
    }
  ]
}
```

The document has no `schema`, no `version`, no `environment`, and no private field. `schema: thoughtproof.keys.v1` is the export document and is not a valid principal manifest. Duplicate `kid` values are not valid. A second key for rotation is a different `kid` on the same `keys` array.

Which physical store receives the write is still the open manifest-store question in the integration plan. This document does not choose a backend and does not share the rate-limit Redis fallback. There is no in-memory store. If the store is not yet chosen, or it does not answer, the result is `store_unavailable` and the operator writes nothing.

### Compare-and-set

Every change uses compare-and-set. That includes a pin, a rotation, a retirement, a revocation, a corrective write, and anything that would otherwise have been a rollback. The operator reads the document and the store's version or etag, builds the next document from that read, and sends the write only with that version or etag. The version or etag is store metadata beside the document. It is not a `version` field on the manifest. A `version` field on the document is malformed. If the store version has moved, the write aborts (`version_mismatch`). The operator does not overwrite the new version with the copy they held.

`revoked` is terminal for that `kid`. A rotation, a retirement, a pin, a corrective write, or a rollback must leave that `kid` on the document with `status: revoked`. A write that would set it to `active` or `retired`, or would drop it, is not sent. A revocation made by another operator in between is kept.

When the store state is unclear, the operator does not write an older document back. Unclear means the load timed out, the answer is partial, or it is not possible to tell whether a write landed. The operator stops, escalates, and re-reads. The only later write is a forward change against the version that re-read returned: add a new `kid`, or move a `kid` that is not `revoked` to `retired` or `revoked`. That write does not resurrect a `kid` and does not put a prior copy of the document back. If the re-read does not answer, the audit result is `failed` with reason `state_unclear`, and the entry does not copy counts from the stale read.

There is no step that restores a previous manifest.

### Read-back

The second operator reads the store with the same `load(accountId)` shape the verifier uses, and treats a load that stays silent past 2000 milliseconds (`PRINCIPAL_MANIFEST_LOAD_DEADLINE_MS`) as no answer.

Acceptance is all of the following:

1. The load answered, and the document parses under the manifest rules.
2. The store key and the document `accountId` both equal the request `accountId`.
3. The new `kid` appears once, with `status` `active`, and with `x`, `notBefore`, and `notAfter` equal to the request strings.
4. The document contains no private-key field and no field the parser would reject.
5. Both operators name the same environment token, and that token is the server target of the store that answered.

A read-back that fails is `readback_failed`. The operator follows the compare-and-set rule above. They do not write the previous document back, and they do not delete the document to undo the attempt. If the new `kid` is `revoked` on that read, the pin is not accepted and `revoked` stays. A mismatched `accountId` is still the verify-path failure HTTP 503 `MANIFEST_MALFORMED`. Correcting it is a forward write against the current version or etag, and that write keeps every `revoked` `kid`. The operator does not finish an accepted pin on a mismatched document. If they cannot tell what the store holds, they stop, escalate, re-read, and re-apply only a forward change.

A successful read-back is not ALLOW, does not set `mandate_source`, and is not a call to `POST /sentinel/verify`.

## Rotation

Rotation is a new `kid` and a new key pair. It is not a new API-key string. The API-key record and the principal manifest are different maps.

1. The holder or admin files a `rotate_add` request for the new key. Possession, identity, and the two-person check are the same as a pin.
2. The operator reads the current document and its version or etag, appends the new key with `status: active`, and leaves every other `kid` as it was read. A `kid` that is `revoked` stays `revoked`. The write is compare-and-set. On `version_mismatch` the operator aborts, re-reads, and re-applies only that forward append. The manifest may hold more than one `kid` so the replacement exists before the old one stops.
3. Read-back shows the new `kid` and shows every `revoked` `kid` still `revoked`, with the counts in the audit entry.
4. A later `retire` request sets a key that is `active` to `retired`, again with compare-and-set. The `kid` stays on the document. It is not deleted and not reused. If that `kid` is already `revoked`, the retirement write is not sent.

The pilot does not change `x` in place under an existing `kid`. A different public key is a different `kid`. Rotation does not undo a revocation.

## Retirement

`retired` is BLOCK `retired` for every new authorization, including when receipt time is inside `notBefore` / `notAfter`, and including when the signer chose an `iat` inside the old window. The 30-second proof skew does not make a retired key active. Retirement uses the same compare-and-set rule. It does not change a `revoked` `kid`, and a failed retirement does not write an older document back.

Historical verification is a separate case. `historicalPrincipalVerification` returns `purpose: historical`, `authorizesExecution: false`, and BLOCK `historical_not_authorization`, whether or not a signature matched and whether the recorded status was `active`, `retired`, or `revoked`. That result is not `mandate_source: principal_signed`. `verdictFromHistoricalVerification` does not return ALLOW. An existing BLOCK stays BLOCK. UNCERTAIN stays UNCERTAIN. A gate ALLOW becomes BLOCK on that path. This admin process does not run historical verification and does not enable it.

## Revocation

`revoked` is BLOCK `revoked` for a new authorization, including inside any old window. The verifier checks `revoked` before the time window. `revoked` is terminal for that `kid`. No later pin, rotation, retirement, corrective write, or rollback sets it back to `active` or `retired`, and none of those deletes it. A replacement key is a new `kid` through the pin steps. The revoked `kid` stays on the document so a later proof selects `revoked` rather than `unknown_kid`.

Revocation blocks new authorizations with that key. It does not automatically stop approvals already issued or actions already running.

### Emergency revocation

**Decided (founder review, 2026-10-28).** An emergency request may come from the holder, from an authorized admin, or from an operator who suspects the private key is exposed. The operator confirms identity on the registry channel when the requester is the holder or the admin. When the operator is acting on suspicion, both the suspicion and the operator id go into the evidence record.

The operator writes `status: revoked` immediately, using compare-and-set against the version or etag just read. The 15 minutes is an internal pilot target for a confirmed read-back of that write. It is not an allowed waiting time before the write. The second person may review the emergency revocation afterwards. That review does not change `revoked` back. If the emergency request was unauthorized, the key stays `revoked`. A replacement still requires the full two-person pin.

A binding SLA is not in force. A binding SLA needs a named on-call and a fixed store. Neither is given yet. Once the store answers with `revoked`, the next verification of a new authorization has no grace period. The revocation still does not automatically stop approvals already issued or actions already running.

If the compare-and-set aborts because the `kid` is already `revoked`, the operator re-reads and does not write an older status. If the store state is unclear, the operator stops, escalates, re-reads, and re-applies only the forward revocation.

There is no emergency pin. Adding a key keeps the two-person check before the write.

## Expiry

Expiry is the `notAfter` bound, not a status. While `status` is `active` and receipt time satisfies `notBefore <= now < notAfter`, the key can be verified. At `now >= notAfter` a new authorization is BLOCK `key_expired`. Before `notBefore` it is BLOCK `key_not_yet_valid`. The proof skew does not move either bound.

The operator does not delete a key when it expires. The document keeps it so the check can return `key_expired`. Deleting it would make the same proof `unknown_kid` once the store has answered. Both are BLOCK. The pilot keeps the key.

The pilot does not edit `notBefore`, `notAfter`, or `x` on an existing `kid`. A longer window, or an earlier end, is a new `kid` through `rotate_add`, then `retire` on the old `kid` when that `kid` is not `revoked`. A `revoked` `kid` stays `revoked`. Both writes use compare-and-set. The old key stays on the document. That stays inside the audit actions above and leaves the original bounds readable.

No job in this process polls for expiry. Operators who want uninterrupted use start rotation before `notAfter`. This document does not create that job.

## Failure modes

These match the stage-3 checks. None of them is ALLOW. A valid signature does not move them. `verdictWithPrincipalCheck` maps an HTTP 503 result to UNCERTAIN, and an existing BLOCK stays BLOCK.

| Situation | Result |
|---|---|
| Manifest document `accountId` differs from the authenticated account (the store key). | HTTP 503 `MANIFEST_MALFORMED`. The other account is not selected. |
| Proof `account_id` differs from the authenticated account. | BLOCK `account_mismatch`. The store is not loaded for the proof's account. |
| Store missing, store throws, load answers `{ answered: false }`, or the load stays silent past 2000 ms. | HTTP 503 `MANIFEST_UNAVAILABLE`. No memory fallback and no pass. |
| Document does not parse (bad timestamp, private field, duplicate `kid`, export schema, unknown field, `notAfter <= notBefore`). | HTTP 503 `MANIFEST_MALFORMED`. |
| Store answered and the `kid` is absent, or the answered manifest is empty. | BLOCK `unknown_kid`. |
| `registerPrincipalKey` invoked by anyone, including an operator. | HTTP 503 `REGISTRATION_UNAUTHORIZED`. No write. |

The operator's audit `reason` uses the admin enums in the audit section. The HTTP codes above are the verifier's codes once the check runs. This process does not add an HTTP route that returns them.

## Non-goals

- No self-service pin, rotation, retirement, or revocation.
- No automated registration and no agent-registered key.
- No change to `registerPrincipalKey`. It stays locked until a separate founder GO. Merging this document does not permit manual pinning, does not unlock that function, does not wire verification, and does not enable an account.
- No wiring into `POST /sentinel/verify`, no enablement, and no suite run.
- No use of the verify API key or `X-Sentinel-Agent-Id` as registration authority.
- No caller-supplied principal manifest and no caller-supplied JWKS URL.
- No private key in the store, the evidence record, the audit log, or this document.
- No public archive of `principal_kid`.
- No standing mandate, no delegation, and no historical-verification path on a new authorization.

## Founder decisions (2026-10-28)

These three items are decided. They are not open questions.

1. **Possession domain.** `thoughtproof.sentinel.principal-key-pin.v1`, one 0x00 byte, then UTF-8 JCS of the challenge. Proof of possession proves key control only. Account authorization is the independent identity check.
2. **Emergency revocation timing.** The operator writes the revocation immediately. Fifteen minutes is the internal pilot target for a confirmed read-back of that write, not an allowed waiting time. The second person may review afterwards. A binding SLA needs a named on-call and a fixed store, which are not given. Revocation blocks new authorizations with that key. It does not automatically stop approvals already issued or actions already running. `revoked` is terminal for that `kid`.
3. **Effect of this document.** Merging it does not permit manual pinning, unlocking `registerPrincipalKey`, wiring, or account enablement.

## Open questions

These operational points are still open. None of them authorizes a write. The decisions above are not in this list.

1. **Challenge window.** Proposed: reuse the mandate proof limits (`exp > iat`, at most 300 seconds, 30 seconds of skew). Confirm or replace those numbers for the admin challenge only.
2. **Challenge field names.** The possession domain is decided. Still open: `schema_version`, `purpose`, and the split between `account_id` / `not_before` / `not_after` on the signed challenge and `accountId` / `notBefore` / `notAfter` on the stored manifest.
3. **Admin pin without a fresh holder confirmation.** Proposed: no. `pin` and `rotate` keep a fresh holder out-of-band confirmation. `retire` and `revoke` may proceed on the admin's registry grant plus admin out-of-band confirmation.
4. **Null bounds and in-place edits.** The verifier allows a null bound as an open side. Proposed pilot: both bounds required, and no in-place change to `x` or to either bound. An earlier end is a new `kid` plus retirement of a `kid` that is not `revoked`.
5. **Evidence contents.** Proposed: the internal evidence record may hold `accountId`, `kid`, and public `x`. The audit log stays status and counts only. Neither record is a public archive. Confirm that split.
6. **Manifest store.** Still open in the integration plan. Which store the operator writes, how its version or etag is read for compare-and-set, and how it stays distinct from the rate-limit Redis that may fall back to memory. This process does not choose it. No pin is executed while it is unset. A binding emergency-revocation SLA also waits on this store.
7. **Registry and on-call.** Proposed: a founder-maintained list of the confirming person, the out-of-band channel, and any admin grant, per `accountId`. Confirm who may edit it and where it lives. It must not live in the request, and it must not contain API keys or private keys. The named on-call for a binding revocation SLA is not given.
