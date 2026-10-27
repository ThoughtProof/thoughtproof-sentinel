# ADR-0023: Principal-signed mandate (P4)

**Status:** Proposed (2026-10-27). Do not merge without Raul GO.
**Decider:** Founder
**Depends on:** canonical v2 (ADR-0022), salted mandate digest ([#99](https://github.com/ThoughtProof/thoughtproof-sentinel/pull/99)), `gate.checked` ([#100](https://github.com/ThoughtProof/thoughtproof-sentinel/pull/100))

This ADR records proposed decisions. It implies no implementation GO and no suite GO. It does not change the API, the engine, the verifier, or any workflow.

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

One shared atomic replay store serves every instance. There is no local fallback. Validity is 5 minutes. Clock skew is at most 30 seconds. Nonces come from a CSPRNG. These are product decisions, not tunable defaults.

### 5. What the signature covers

The signature covers one concrete action: the full, uniquely normalized mandate, including `action`, in the versioned form below. Signing only `granted` would be a reusable standing mandate and would need its own rules for usage, total budget, and delegation. That is out of scope here.

P1's salted digest is not the signature payload. The salt is generated on the server per request and must stay off the public artifact. The principal does not have it when signing. `mandateDigest` stays the P1 commitment on v2. The signature is a separate check. A blind signing service that signs whatever an agent submits only moves the trust problem.

### Key distribution

Registration is separately authorized. The principal generates the key pair and holds the private key. Sentinel stores only the public key, in a server-pinned manifest for that account. The agent cannot have arbitrary mandates signed, and it cannot register its own key.

`principal_kid` selects one Ed25519 key in that manifest. The document is close to the existing key doc (OKP, `kid`, `status`, `notBefore`, `notAfter`) and is not the public export JWKS at `/.well-known/thoughtproof-keys.json`. The caller-supplied F1 `key_manifest` stays an evidence manifest. It is not the principal manifest. A caller-supplied JWKS URL is rejected: the request would choose its own trust anchor.

## Account binding

A trustworthy key-to-manifest mapping is a prerequisite. `validateApiKey` today returns `platform` and `agent_id`, not a stable account id. The manifest is loaded for the account that mapping identifies. A request field must not name the account. `X-Sentinel-Agent-Id` must not name it either.

## Envelope

Transport and verify the same fields. The signed message is JCS of a versioned object, UTF-8, then Ed25519, under a domain separator distinct from `thoughtproof.sentinel.export.v1`:

- schema version
- normalized mandate, including `action`
- `nonce`, `iat`, `exp`
- `principal_kid`
- the signed account id from the binding above
- target environment
- purpose

Purpose and schema version are audience binding. Evidence types keep their own validation rules. A mandate signature is not an evidence signature and is not an export signature.

`mandate_sig` and `principal_kid` are the additive request fields. On success, v2 carries `mandate_source: principal_signed`, bound to the mandate that verified. v1 bytes do not gain the field. The signature bytes and the mandate plaintext are not v2 fields.

MCP `verify_before_action` and OpenAPI gain the same optional request fields and document `mandate_source` on the v2 body. Optional in the schema means non-migrated clients can omit them. It does not override an account policy that requires the signature. v1 `signed_export` is unchanged.

## Replay and rotation

After the signature verifies, consume the nonce in the shared store atomically, before any paid call or other relevant side effect. Two parallel requests with the same nonce must not both pass. Do not retry a proof from the start. A lost response needs a new proof.

The manifest may hold more than one kid so a replacement key can be registered before the old one is retired. Rotation and revocation are account actions outside `POST /sentinel/verify`. The verify caller cannot add, retire, or revoke a kid.

| Status | New authorization request |
|---|---|
| `active` | Verify. `iat` must sit inside `notBefore` / `notAfter`, within the 30-second skew. `exp` must fall inside the 5-minute validity. |
| `retired` | BLOCK for a new authorization request. An `iat` the signer chose does not prove the proof was made while the key was active. |
| `revoked` | BLOCK, including inside any old window. |

An unknown kid, once the store has answered, is known-invalid and is BLOCK. A store that does not answer is the unverifiable case in decision 2.

Checking a historical signature later is a separate case. It is not this request path, and it still cannot authorize a new execution.

## Normalization

Today's validation rewrites aliases and drops fields. "The full validated object" is therefore not a signature payload. The signer, the authorization gate, and the P1 digest all use one versioned representation. A security-relevant field must not disappear in that step. JCS canonicalizes whatever object it is given. It does not decide which fields exist.

The later offline vectors cover aliases, unknown fields, and `__proto__`.

## Failure behavior and privacy

A failed principal check must not become ALLOW, including when v2 issuance fails and `signed_export_v2` is omitted. `principal_signed` is set only for the mandate that verified. An existing BLOCK must not be weakened to UNCERTAIN.

`principal_kid` is not automatically archived in public. A stable kid can link accounts or persons. Public material, when a surface is explicitly chosen later, is limited to kid and status, and only on that surface. The mandate plaintext, `mandate_sig`, the salt, and the digest preimage stay off the public receipt allowlist. `signed_export_v2.canonical` stays off that allowlist. `mandate_source` is an enum on v2. It is not a reason to publish the mandate.

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

- Crypto vectors for a valid signature, a wrong key, a tampered byte, expiry, skew, replay, and a domain separator that does not verify as an export or as evidence.
- Offline normalization vectors for aliases, unknown fields, and `__proto__`, showing the signer, the gate, and the digest see the same representation.
- Negative matrix: protection on and the mandate omitted, one of `mandate_sig` / `principal_kid` missing, unknown kid, revoked kid, retired kid presented as a new request, replay store down, two parallel uses of one nonce. Known-invalid cases are BLOCK. Store-down is UNCERTAIN or 503. None is ALLOW, and none turns a BLOCK into UNCERTAIN.
- Verdict invariance across the P3 gate matrix with `mandate_source` varied, including a valid signature on a case that is already BLOCK or UNCERTAIN.
- A paid suite only on a later PR that touches `src/engine/**`. This ADR does not authorize that run.
