# ADR-0023: Principal-signed mandate (P4)

**Status:** Proposed (2026-10-27). Do not merge without Raul GO.
**Decider:** Founder
**Depends on:** canonical v2 (ADR-0022), salted mandate digest ([#99](https://github.com/ThoughtProof/thoughtproof-sentinel/pull/99)), `gate.checked` ([#100](https://github.com/ThoughtProof/thoughtproof-sentinel/pull/100))

This document is the decision. It does not change the API, the engine, or the verifier.

## Context

On `action_authorization` the mandate is whatever the caller puts in the request. The caller is often the agent or the model host. A caller-supplied `key_manifest` has the same limit: it shows that a signature matches a key the caller named, not that an independent principal authorized the spend (see the trust note on `key_manifest` in `src/types.ts`).

Canonical v2 can already commit to that caller mandate. P1 puts `mandateDigest` on the v2 body as `sha256(salt || JCS(mandate))`. The salt stays off the signed body and off the public receipt, because an unsalted hash of a low-entropy mandate is a dictionary. P3 puts `gate.checked` / `gate.skipped` on v2 so a receipt shows which deterministic checks ran. Neither field says the principal, rather than the caller, is the source of the mandate.

## Proposed decision

### 1. Trust model

The principal is the party whose authority is being spent. The API caller is not that party.

| Option | Meaning | Why not, if rejected |
|---|---|---|
| A. Caller is the principal | Today's behavior. The request body is the mandate. | This is the critique. |
| B. Account holder | The authenticated Sentinel account owns the keys. | Proposed default. |
| C. Delegated key under the account | A human, org, or device key registered on that account. | Allowed later, still not the caller. |

Proposed: B now, with C as extra kids on the same account manifest. The model, the MCP host, and the API key are callers. They may submit mandate bytes. They do not become the principal by calling `verify`.

### 2. Key distribution

Proposed: a server-pinned manifest per account. The verify handler loads it for the authenticated account. The request does not carry the manifest.

- `principal_kid` selects one key in that manifest.
- Algorithm is Ed25519.
- Document shape matches the existing key doc closely enough to verify the same way: OKP, `kid`, `status`, `notBefore`, `notAfter`. It is not the public `/.well-known/thoughtproof-keys.json` set. Those keys sign exports. These keys sign mandates.
- The caller-supplied `key_manifest` stays the F1 evidence manifest. It is not reused as the principal manifest. A caller who supplies both the signature and the trust anchor has not answered the critique.

Rejected: a caller-supplied JWKS URL fetched at verify time. That reintroduces "trust whatever the request points at" and a network hop on the verify path.

### 3. What is signed

P1's salted digest is the wrong signature payload. The salt is generated on the server per request and must not be public. The principal does not have it when signing.

Proposed signed message, JCS, UTF-8, then Ed25519:

- the mandate object that P1 already commits (the validated mandate, not a projection that drops fields)
- `nonce` (single use)
- `iat` and `exp` (unix seconds)
- `principal_kid`
- a domain separator distinct from `thoughtproof.sentinel.export.v1`, so a mandate signature cannot be confused with an export signature

`mandateDigest` stays P1: `sha256(salt || JCS(mandate))` on v2. The signature is a second check over the mandate bytes plus anti-replay fields. It does not replace the digest, and the digest does not replace the signature.

Replay: reject `exp` in the past, and reject a nonce the account has already used. A captured `mandate_sig` must not authorize a second request.

Rejected: signing only `mandateDigest`. The principal would have to know the server salt, which would publish the dictionary key next to the digest or force the salt into the signed payload.

### 4. Request fields and the v2 body

Additive request fields:

- `mandate_sig` — Ed25519 signature, hex
- `principal_kid` — kid in the account manifest

Both absent: `mandate_source` is `caller_declared`. That is today's path.

Both present: verify. On success the v2 body field is `mandate_source: principal_signed`. On failure see the invariants below. Do not store the signature or the mandate in the v2 body.

One present and the other absent: not "unsigned." Treat as unverifiable.

`mandate_source` is v2 only (`principal_signed` | `caller_declared`). v1 bytes stay as they are. Absent mandate: omit the field. Do not write null.

### 5. Rotation and revocation

The account manifest may hold more than one kid so a new key can overlap the old one.

| Status | Verify result |
|---|---|
| `active` | Verify if `iat` is inside `notBefore` / `notAfter`. |
| `retired` | Same window check against `iat`. Not a new enrollment path. |
| `revoked` | Unverifiable immediately, including inside the old window. |

Rotation is an account action outside `POST /sentinel/verify`. The verify caller cannot add, retire, or revoke a kid. Unknown kid, missing manifest, and revoked kid are unverifiable. They are not a silent fallback to `caller_declared`.

### 6. MCP and OpenAPI

Additive only. MCP `verify_before_action` gains optional `mandate_sig` and `principal_kid`. OpenAPI documents the same two fields and `mandate_source` on the v2 body. Clients that omit them stay on `caller_declared`. No new required field. No change to v1 `signed_export`.

## Invariants

These are not options.

1. A valid signature never upgrades a verdict to ALLOW. It only sets `mandate_source` to `principal_signed`. The gate, the promotion, and the fail-safe still decide ALLOW, BLOCK, or UNCERTAIN. A gate BLOCK stays BLOCK. A promotion UNCERTAIN stays UNCERTAIN.
2. An invalid signature, an unverifiable kid, a missing manifest, a bad nonce, or a stale `exp` yields UNCERTAIN or BLOCK. It is never ignored and never stored as `caller_declared`.
3. UNCERTAIN, evaluator error, HTTP 5xx, 401, and 429 never become ALLOW because a signature was present.

Proposed mapping, matching signed evidence: a signature that fails cryptographically is BLOCK; a key the server cannot evaluate (unknown kid, absent manifest, revoked, expired window, replay store unavailable) is UNCERTAIN. The founder question below can swap BLOCK and UNCERTAIN. It cannot add a third outcome of "ignore" or ALLOW.

## Privacy

Public material is `principal_kid` and key status only. The mandate plaintext, `mandate_sig`, the salt, and `mandateDigest`'s preimage stay off the public receipt allowlist. `signed_export_v2.canonical` stays off that allowlist. `mandate_source` is an enum and may be signed on v2. It is not a reason to publish the mandate.

## Non-goals

- No implementation in this ADR.
- No change to v1 bytes, to P1's salt, or to P3's `gate.checked` rules.
- No use of the signature as a promotion input.
- No caller-supplied principal manifest.
- No new public copy of the mandate, the signature, or the salt.

## Later test plan

When an implementation PR is opened, and not before:

- Crypto vectors: valid signature, wrong key, tampered mandate byte, expired `exp`, reused nonce, domain separator not interchangeable with the export envelope.
- Negative matrix: one of the two fields missing, unknown kid, revoked kid, retired kid outside the window, manifest missing, replay store down. Each case is UNCERTAIN or BLOCK, and none is ALLOW.
- Verdict invariance: the same gate and promotion matrix as P3, with `mandate_source` varied, including a valid signature on a case that is already UNCERTAIN or BLOCK.
- Paid suite only on the PR that touches `src/engine/**`. This ADR does not.

## Open founder questions

1. Is the principal always the account holder (B), or do we need named delegated kids (C) in the first implementation?
2. For a bad signature, is the public verdict BLOCK or UNCERTAIN? Unverifiable keys are proposed as UNCERTAIN.
3. If the account has a manifest, may a caller still omit `mandate_sig` and remain `caller_declared`, or does a pinned manifest require a signature?
4. Where do single-use nonces live, and how long is `exp` allowed to be?
5. Is the signed mandate the whole validated object, or only `granted`?
