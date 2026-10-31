# ADR-0023: Principal-signed mandate (P4)

**Status:** Proposed (2026-10-27). Do not merge without Raul GO.
**Decider:** Founder
**Depends on:** canonical v2 (ADR-0022), salted mandate digest ([#99](https://github.com/ThoughtProof/thoughtproof-sentinel/pull/99)), `gate.checked` ([#100](https://github.com/ThoughtProof/thoughtproof-sentinel/pull/100))

This ADR records proposed decisions. It implies no implementation GO and no suite GO. It does not change the API, the engine, the verifier, or any workflow. The request format, the account-id equality check, the receipt-time and replay rules, and the suite path list below are prerequisites for a later implementation GO. They are not that GO.

## Context

On `action_authorization` the mandate is whatever the caller puts in the request. The caller is often the agent or the model host. A caller-supplied `key_manifest` has the same limit: it shows that a signature matches a key the caller named, not that an independent principal authorized the spend (see the trust note on `key_manifest` in `src/types.ts`). `validateApiKey` returns a platform and an optional agent id. It does not return a stable account id.

Canonical v2 can commit to that caller mandate. P1 puts `mandateDigest` on the v2 body as `sha256(salt || JCS(mandate))`. The salt stays off the signed body and off the public receipt, because an unsalted hash of a low-entropy mandate is a dictionary. P3 puts `gate.checked` / `gate.skipped` on v2 so a receipt shows which deterministic checks ran. Neither field says the principal, rather than the caller, is the source of the mandate.

## Proposed decisions

These replace the earlier open questions.

### 1. Who the principal is

The principal is the person or organization whose resources or authority are affected. On ThoughtProof's own account, that is the legitimate ThoughtProof responsible. On a customer account, that is the customer. An intermediary account is not automatically enough.

Delegation comes later, and only when it is explicit and scoped. Extra keys kept for rotation are not delegation. The model, the MCP host, and the API key are callers. They may submit bytes. They do not become the principal by calling `verify`.

### 2. Failure outcomes

A known-invalid proof gives BLOCK. That includes a bad signature, a revoked key, an expired proof, a replay, and a missing signature where the account policy requires one. A technically unverifiable check, meaning the key store or the replay store is down, gives UNCERTAIN / HTTP 503. Neither outcome permits execution.

### 3. When the signature is mandatory

Once protection is enabled for an account, the signature is mandatory. The requirement comes from server-side account policy, including when the caller omits the whole mandate. Accounts that have not been migrated stay explicitly `caller_declared`.

### 4. Replay parameters

One shared atomic replay store serves every instance. There is no local fallback. Validity is 5 minutes, and the window must be strictly positive (`exp > iat`). Clock skew is at most 30 seconds. Nonces come from a CSPRNG. These are product decisions, not tunable defaults. The atomic consume step re-checks expiry against server time before the nonce is spent.

### 5. What the signature covers

The signature covers one concrete action: the full, uniquely normalized mandate, including `action`, in the versioned form below. Signing only `granted` would be a reusable standing mandate and would need its own rules for usage, total budget, and delegation. That is out of scope here.

P1's salted digest is not the signature payload. The salt is generated on the server per request and must stay off the public artifact. The principal does not have it when signing. `mandateDigest` stays the P1 commitment on v2. The signature is a separate check. A blind signing service that signs whatever an agent submits only moves the trust problem.

### Key distribution

Registration is separately authorized. The principal generates the key pair and holds the private key. Sentinel stores only the public key, in a server-pinned manifest for that account. The agent cannot have arbitrary mandates signed, and it cannot register its own key.

The pilot manual process for a pin, a rotation, a retirement, and a revocation is [ADR-0023 key-pinning admin process](ADR-0023-key-pinning-admin-process.md). Merging that document does not permit manual pinning, does not unlock `registerPrincipalKey`, does not wire verification, and does not enable an account. The read-only proof that each API key maps to one account is the [key-to-account migration addendum](ADR-0023-key-account-migration-addendum.md).

`principal_kid` selects one Ed25519 key in that manifest. The document is close to the existing key doc (OKP, `kid`, `status`, `notBefore`, `notAfter`) and is not the public export JWKS at `/.well-known/thoughtproof-keys.json`. The caller-supplied F1 `key_manifest` stays an evidence manifest. It is not the principal manifest. A caller-supplied JWKS URL is rejected: the request would choose its own trust anchor.

## Account binding

A trustworthy key-to-manifest mapping is a prerequisite. `validateApiKey` today returns `platform` and `agent_id`, not a stable account id. The manifest is loaded for the account that mapping identifies. The request must not select the account. A signed account id may be included in `mandate_proof`, and it must exactly equal the server-side authenticated account id. A mismatch gives BLOCK. `X-Sentinel-Agent-Id` must not select the account either.

The manifest document carries `accountId` in addition to the store key. The load uses only the authenticated account. A delivered document whose `accountId` is not that account is an invalid manifest. It does not select another account.

## Envelope

Transport and verify the same fields. Ed25519 is over the UTF-8 signed input below. The domain is distinct from `thoughtproof.sentinel.export.v1`, and it is not optional. There is no fallback that verifies a signature over unprefixed JCS.

```
signed_input =
  UTF-8("thoughtproof.sentinel.mandate.v1")
  || 0x00
  || UTF-8(JCS(envelope))
```

`envelope` is the versioned object below. `signature` is not a field of that object. One 0x00 byte separates the domain from the JCS. A signature over the export domain, over an evidence payload, or over the JCS alone does not verify.

- schema version
- normalized mandate, including `action`
- `nonce`, `iat`, `exp`
- `principal_kid`
- the signed account id from the binding above
- target environment
- purpose

Purpose and schema version are audience binding. Evidence types keep their own validation rules. A mandate signature is not an evidence signature and is not an export signature. The signature is not part of the signed bytes.

### Request format

The envelope travels as one additive object, `mandate_proof`, beside the existing `mandate`. It is not two loose fields `mandate_sig` and `principal_kid`. `mandate` stays the mandate. `mandate_proof` carries the envelope and the signature. The signature is over `thoughtproof.sentinel.mandate.v1`, one 0x00 byte, and the JCS bytes of the normalized mandate plus every `mandate_proof` field except `signature`.

| Field | Role |
|---|---|
| `schema_version` | Audience and representation version. |
| `nonce` | Single-use CSPRNG value. |
| `iat`, `exp` | Unix seconds. Checked against server receipt time as below. |
| `account_id` | Must equal the authenticated account id. It does not select the account. |
| `environment` | Target environment. v1 is exactly `production`, `preview`, or `development`. Compared, exactly, with the trusted server-side target injected beside the check. It is not taken from the manifest or the proof. Any other proof value, including whitespace, is BLOCK. A mismatch is BLOCK. A missing or non-exact server target is HTTP 503. |
| `purpose` | Purpose string. `action_authorization` for this path. |
| `principal_kid` | Kid in the server-pinned manifest. |
| `signature` | Ed25519 over the signed message, hex. |

Placeholder example only. These values are not a vector and not a key.

```json
{
  "mandate": {
    "kind": "value_transfer",
    "granted": {
      "maxAmount": 1,
      "asset": "PLACEHOLDER_ASSET",
      "recipient": "placeholder-recipient"
    },
    "action": {
      "kind": "value_transfer",
      "amount": 1,
      "asset": "PLACEHOLDER_ASSET",
      "recipient": "placeholder-recipient"
    }
  },
  "mandate_proof": {
    "schema_version": "sentinel.mandate-proof.v1",
    "nonce": "placeholder-nonce",
    "iat": 1780000000,
    "exp": 1780000300,
    "account_id": "placeholder-account",
    "environment": "production",
    "purpose": "action_authorization",
    "principal_kid": "placeholder-kid",
    "signature": "placeholder-signature"
  }
}
```

On success, v2 carries `mandate_source: principal_signed`, bound to the mandate that verified. v1 bytes do not gain the field. The signature bytes and the mandate plaintext are not v2 fields.

MCP `verify_before_action` and OpenAPI gain optional `mandate_proof` and document `mandate_source` on the v2 body. Optional in the schema means non-migrated clients can omit the object. It does not override an account policy that requires it. v1 `signed_export` is unchanged.

## Replay and rotation

Let `now` be the server receipt time in unix seconds. Skew is 30 seconds. Accept the times only when all of these hold:

- `exp > iat` (strictly positive window; `iat == exp` is rejected, as is `exp < iat`)
- `iat <= now + 30`
- `exp > now - 30`
- `exp - iat <= 300`

The key must be `active` at receipt time: `notBefore <= now < notAfter` for each bound that is set. `notAfter` is exclusive. A null bound is open on that side. The 30-second proof skew does not apply to this window. `iat` does not choose it. A signer-chosen `iat` does not make a retired or not-yet-valid key active. If both bounds are set, `notAfter` must be greater than `notBefore`. Otherwise the manifest is invalid.

`notBefore` and `notAfter` are strict RFC3339 UTC timestamps with second resolution (`YYYY-MM-DDTHH:MM:SSZ`). The text must round-trip through the calendar. A date `Date.parse` would normalize, including `2026-02-30T00:00:00Z`, is not that instant. An invalid timestamp makes the manifest invalid.

After the signature verifies, consume the nonce in the shared store atomically, before any paid call or other relevant side effect. That step re-checks expiry against server time with the same 30-second skew (`exp > now - 30`). A proof that expired between validation and consumption is BLOCK. It is never ALLOW. Two parallel requests with the same nonce must not both pass. Do not retry a proof from the start. A lost response needs a new proof.

A consumed nonce is retained at least until `exp + skew`. No replay entry may expire while the proof could still be accepted. If the replay store or the key store is unavailable, the result is UNCERTAIN / HTTP 503, not a pass and not a local fallback.

The manifest may hold more than one kid so a replacement key can be registered before the old one is retired. Rotation and revocation are account actions outside `POST /sentinel/verify`. The verify caller cannot add, retire, or revoke a kid. The pilot steps for those actions are the [key-pinning admin process](ADR-0023-key-pinning-admin-process.md).

| Status | New authorization request |
|---|---|
| `active` | Verify. The key window is `notBefore <= now < notAfter` (`notAfter` exclusive), not `iat`, and not the 30-second proof skew. |
| `retired` | BLOCK for any new authorization. Historical verification is a separate case and is out of scope on this path. An `iat` the signer chose does not prove the proof was made while the key was active. |
| `revoked` | BLOCK, including inside any old window. |

An unknown kid, once the store has answered, is known-invalid and is BLOCK. A store that does not answer is the unverifiable case in decision 2.

Checking a historical signature later is a separate case. It is not this request path, and it still cannot authorize a new execution.

## Normalization

Today's validation rewrites aliases and drops fields. "The full validated object" is therefore not a signature payload. The signer, the authorization gate, and the P1 digest all use one versioned representation. A security-relevant field must not disappear in that step. JCS canonicalizes whatever object it is given. It does not decide which fields exist.

The later offline vectors cover aliases, unknown fields, and `__proto__`.

## Failure behavior and privacy

A failed principal check must not become ALLOW, including when v2 issuance fails and `signed_export_v2` is omitted. `principal_signed` is set only for the mandate that verified. An existing BLOCK must not be weakened to UNCERTAIN.

`principal_kid` is not automatically archived in public. A stable kid can link accounts or persons. Public material, when a surface is explicitly chosen later, is limited to kid and status, and only on that surface. The mandate plaintext, `mandate_proof.signature`, the salt, and the digest preimage stay off the public receipt allowlist. `signed_export_v2.canonical` stays off that allowlist. `mandate_source` is an enum on v2. It is not a reason to publish the mandate.

## Invariants

1. A valid signature never upgrades a verdict to ALLOW. It sets `mandate_source` to `principal_signed` for the verified mandate. The gate, the promotion, and the fail-safe still decide the verdict. A gate BLOCK stays BLOCK.
2. Known-invalid proofs are BLOCK. Technical unverifiability is UNCERTAIN or HTTP 503. Neither is stored as `caller_declared`, and neither permits execution.
3. UNCERTAIN, evaluator error, HTTP 5xx, 401, and 429 never become ALLOW because a signature was present.

## Product boundary

`mandate_source: principal_signed` is, at first, Sentinel's signed statement that Sentinel performed this check. An external verifier that checks `signed_export_v2` does not thereby verify the principal signature. That check also needs the private proof and a trusted key mapping. P4 does not by itself stop a second real execution. The service that executes must consume the approval bindingly, and once.

## Non-goals

- No implementation, and no suite run, under this ADR.
- No change to v1 bytes, to P1's salt handling, or to P3's rule that `gate.checked` does not affect the verdict.
- No use of the signature as a promotion input.
- No caller-supplied principal manifest, and no agent-registered key.
- No standing mandate over `granted` alone.
- No public archive of `principal_kid` by default.

## Later test plan

Only after a separate implementation GO, and not as part of accepting this ADR:

- Crypto vectors for a valid signature, a wrong key, a tampered byte, expiry, skew, replay, and a domain separator that does not verify as an export, as evidence, or as unprefixed JCS. The mandate vector is `thoughtproof.sentinel.mandate.v1`, one 0x00 byte, then UTF-8 JCS of the envelope.
- Offline normalization vectors for aliases, unknown fields, and `__proto__`, showing the signer, the gate, and the digest see the same representation.
- Negative matrix: protection on and `mandate_proof` omitted, a required `mandate_proof` field missing, `account_id` not equal to the authenticated account, unknown kid, revoked kid, retired kid presented as a new request, replay store down, two parallel uses of one nonce, and a nonce entry dropped before `exp + skew`. Known-invalid cases are BLOCK. Store-down is UNCERTAIN or 503. None is ALLOW, and none turns a BLOCK into UNCERTAIN.
- Verdict invariance across the P3 gate matrix with `mandate_source` varied, including a valid signature on a case that is already BLOCK or UNCERTAIN.
- The paid live suite is the `pull_request` path filter in `.github/workflows/action-authorization-suite.yml`. A later PR that changes any of these paths starts that workflow: `scenarios/action-authorization-suite.json`, `scripts/action-authorization-suite.mjs`, `scripts/lib/action-auth-suite-metrics.mjs`, `scripts/lib/action-auth-suite-receipt.mjs`, `.github/workflows/action-authorization-suite.yml`, and `src/engine/**`. This ADR does not change those paths and does not authorize that run.
