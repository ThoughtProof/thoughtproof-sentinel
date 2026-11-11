# Security Model — ThoughtProof Sentinel

**Scope:** `sentinel.thoughtproof.ai` verification API, including F1 action-bound
evidence verification (`signed_event`, `package_digest`, `proof_strength`).
**Last updated:** 2026-11-11 (action-binding predicate)

This document is the searchable home of the trust and threat model. It exists so
integrators, auditors, and reviewers do not have to extract security posture from
inline code comments.

---

## 1. What Sentinel is — and is not

| | |
|---|---|
| **Is** | A verification oracle: it returns ALLOW / BLOCK / UNCERTAIN plus objections for a submitted decision package |
| **Is not** | An execution boundary. A verdict does not stop anything by itself — an integrator (agent runtime, workflow engine, gate) must enforce it |
| **Is not** | An authorization system. Sentinel does not grant permissions; it evaluates whether a proposed action is justified by mandate and evidence |

**Fail-closed doctrine:** when the verifier cannot reach a confident result, the
safe default is *not to act*. Downgrades (ALLOW → UNCERTAIN → BLOCK) are always
permitted; upgrades never are.

---

## 2. F1 trust model — who vouches for what

F1 lets callers attach cryptographically signed evidence (`signed_event`) to a
verification request. The verifier **recomputes** signatures instead of trusting
presented claims ("evidence-verifying, not evidence-consuming").

### 2.1 What F1 proves

| Statement | Guaranteed by |
|---|---|
| The evidence bytes carry a valid ed25519 signature over the JCS-canonical payload | Signature recomputation in `src/signed-evidence.ts`, and again in `scripts/verify-receipt.mjs` when the caller passes trusted keys (§2.6). BIP-340/Nostr is not verified |
| The verdict is bound to the exact request package (not a paraphrase, not "current room state") | `package_digest` = sha256 over JCS-canonical request, emitted in `meta` |
| When a signed payload claims an approval digest, that digest equals sha256 of this request's `proposed_action` | Action-binding predicate (§2.7). Outer claims are not the digest |
| A declared signer key is listed as `active` in the *supplied* manifest, within time bounds, with matching roles | Manifest consistency check. Role names are still the outer `claims` strings (§2.7) |
| A third party can recompute the `package_digest`, the ed25519 signature, and the action-binding predicate offline from the accepted request | `scripts/verify-receipt.mjs` recomputes the digest and, with trusted keys, ed25519 over each JCS payload, then runs the same action-binding predicate as the server (§2.6, §2.7). It does not trust `meta.evidence_verification[].status` |

### 2.2 What F1 does **not** prove (v0)

> **Inline-manifest limitation (the load-bearing caveat).**
> The key manifest is supplied **by the caller, inline in the request**.
> Therefore a passing manifest check proves:
>
> *"the evidence signature matches a key the caller declared authorized"*
>
> It does **not** prove:
>
> *"the signer is authorized by any independent authority."*
>
> An attacker who controls the request controls both the evidence and the
> manifest — self-vouching is circular. v0 manifest checks are **structure and
> consistency validation**, not third-party authorization proof.

**When this matters:** if your threat model includes a malicious or compromised
*caller* (not just a malicious agent downstream of the caller), v0 inline
manifests are insufficient. You need one of the production paths below.

**Production paths (not yet implemented):**

1. **Server-pinned manifests** — operator/account-scoped manifests stored by
   ThoughtProof; the request references them by id, the server resolves them.
   Trust anchor: the operator's account, not the request body.
2. **`key_manifest_ref` resolution** — fetch manifest from a content-addressed,
   versioned URL that is itself signed, with its own rotation/revocation chain.
   Trust anchor: the manifest publisher's root key.
3. **Registry binding** — signer authorization checked against an external
   registry (e.g. ERC-8004-style identity) rather than caller input.

### 2.3 `proof_strength` semantics

| Value | Meaning |
|---|---|
| `recomputed` | Every required `signed_event` passed signature verification (and manifest checks, where a manifest was supplied). An item that claims an approval digest also matched `proposed_action` (§2.7) |
| `unverified` | At least one required item could not be fully recomputed, or no signed evidence was supplied at all |

`proof_strength` is emitted **only** when the request contains `signed_evidence`.
Requests without it produce the pre-F1 response shape byte-identically
(backward compatibility; canonical verdict bodies unchanged).

### 2.4 Caller-declared strictness (`verification: required | optional`)

This field is caller-controlled: a caller can mark every item `optional`, in
which case no verdict forcing occurs. This is **intentional policy delegation**:

- Evidence verification results are **always reported** (`meta.evidence_verification`,
  `proof_strength`) regardless of strictness — the information cannot be hidden.
- Forcing **only downgrades**; it can never turn BLOCK/UNCERTAIN into ALLOW.
- Deployments that need a strictness floor must enforce it server-side by
  operator/policy, not by trusting the request field.

### 2.5 Strict request-shape validation (F3)

`package_digest` binds the verdict to the **validated** request bytes. If the
validator silently dropped unknown fields, a caller could attach data (e.g.
custom metadata, provenance hints) and believe those bytes were committed to
the digest — they would not be. That is an interop trap and a subtle integrity
gap.

As of F3, the top-level `/verify` request body and each `signed_evidence[i]`
item are validated against a **strict whitelist**. Any unknown field causes a
400 response naming the offending field and listing the allowed set, so
integrators can self-correct without consulting docs.

Scope: the two layers whose bytes flow directly into `computePackageDigest`.
Deeper nested objects (`agent_context`, `key_manifest`, `mandate`) already
reconstruct clean output objects during validation, so unknown fields there
never reach the digest.

**Implication for section 2.1 row 4 ("third party can recompute offline").**
The `package_digest` recompute claim holds unconditionally for any request the
server accepted: rejected requests never produce a receipt at all. The
signature-verification part of that row is bounded separately in §2.6.

### 2.6 Trust boundary in `scripts/verify-receipt.mjs` (portable verifier)

**What the portable script does (F1 + F5).**

1. **F1 — `package_digest`.** Given `(receipt, original-request)`, recomputes
   the digest offline with the same JCS (`canonicalize` package) + sha256
   path as the server (`src/package-digest.ts`) and compares to
   `meta.package_digest`.
2. **F5 — offline ed25519.** Given the original request's
   `signed_evidence[]` **and** caller-supplied trusted key material
   (`--trusted-pubkey <hex>` and/or `--trusted-key <id>=<hex>`), recomputes
   ed25519 over the JCS-canonical payload inside each `raw_event` using the
   same algorithm as `src/signed-evidence.ts`. Exit non-zero on any failure.
3. **Action-binding.** After a signature verifies, the script calls
   `checkActionBinding` from `src/action-binding-core.mjs` — the same module
   the server uses. Each item reports `signature`, `binding`, and `authority`
   separately (`passed`, `failed`, or `not_checked` when that stage did not
   run). Authority in this script is the caller-supplied trusted key.
   `authority: passed` confirms that CLI trust anchor only. It is not the
   inline key manifest. A recognised approval that fails any of the three
   exits 1. Evidence that is not an approval leaves binding `not_checked`
   and keeps the previous exit code. With no trusted key the process still
   exits 1, and every item still prints a `PORTABLE_ITEM` line. Authority is
   `failed` when the signer can be read, and `not_checked` when the item
   fails before that stage.
4. **Signed claims shape.** After the signature and the binding check pass,
   the script calls `readSignedClaims` from `src/signed-claims.mjs`, the same
   function as the server. A present `claims` value that is not an array of
   non-empty strings is `signed_claims_malformed` and exits 1. A missing
   `claims` field stays "no signed claims".

**What it never does.** It does **not** treat
`meta.evidence_verification[i].status` as proof. Server-emitted statuses are
at most printed as an informational cross-check against the offline result.
A forged receipt that claims `status: "recomputed"` with an invalid
`raw_event` signature fails offline when trusted keys are supplied.

**Trusted key material is caller-supplied only.** There is no built-in
well-known manifest, registry lookup, or revocation authority in this
script. That is intentional:

- A published key manifest (HTTPS or even a signed file) is only an interim
  key-distribution mechanism. Without an out-of-band root pin, monotonic
  version memory, and an external freshness anchor, it does **not** provide
  authoritative revocation freshness or replay protection.
- `status: revoked` style policy, temporal windows, and on-chain key rotation
  (ERC-8004-shaped) remain **out of scope** for F5. If a manifest is used
  later: revoked rejects unconditionally; `valid_from`/`valid_to` must not
  be checked against the signer's self-declared event time.

**Fail-closed rules.**

| Condition | Exit |
|---|---|
| Missing `original-request.json` | 2 |
| Digest mismatch / missing / uncomputable | 1 |
| `signed_evidence` present, no trusted keys supplied (each item still prints `PORTABLE_ITEM`) | 1 |
| `signer_pubkey` not in trusted set / key_id mismatch | 1 |
| Missing/malformed `raw_event` | 1 |
| Invalid ed25519 over JCS-canonical payload | 1 |
| Recognised approval fails action-binding (mismatch, missing action, unknown profile, or any other `action_binding_*` code) | 1 |
| Signed payload `claims` is present but not an array of non-empty strings | 1 |
| All requested checks pass | 0 |

**Dependency note.** Signature and digest recompute require the same
`canonicalize` package the server uses (install via `npm i` in this repo).
Matching the server byte-for-byte matters more here than a second pure-JS
JCS that could silently diverge.

**Still separate (not F5).**

- Signed server responses (server signs its own output envelope).
- Registry-backed key rotation / ERC-8004 authority.
- Authoritative revocation freshness (transparency log / on-chain).
- Inline key-manifest policy (revocation, roles, validity window). The portable authority stage is only the caller-supplied trusted key. Exit 0 means the digest, ed25519, and — when the payload is an approval — action-binding checks passed. It does not mean a release was executed.

### 2.7 Action-binding predicate

Signature verification shows that a key signed a payload. It does not show that the payload approves the action in this request. The predicate closes that gap for one explicit shape. It runs inside `verifySignedEvidence`, which `processSignedEvidence` calls. `applyEvidenceEffects` runs after the engine, so a cascade ALLOW or UNCERTAIN does not survive a failed check. The financial authorization gate is not this check and does not read release digests.

**When it runs.** A signed evidence item is an approval-digest claim only when the signed payload object has an own property `binding_profile`, `approves_release_sha256`, or `approves_sha256`, or when an outer claim is exactly `approves_release_sha256`, `approves_sha256`, or `approves_action_sha256`, or one of those names plus a `:` suffix. Anything else skips the predicate. Existing requests that do not carry such a claim keep signature-only verification.

**What it compares.** The digest is read only from the signed payload. Outer claim text can force the check and can never satisfy it. If the claim is only outside the signature, the result is `action_binding_digest_not_signed`.

1. `binding_profile`, if present, must be exactly `thoughtproof.sentinel.action_binding.v1`. Any other value is `action_binding_unsupported_profile`.
2. Profile v1 requires `approves_sha256`. A payload with no profile uses `approves_release_sha256` and/or `approves_sha256` (`approves_release_sha256` is the Buzz approval-content field). Each present field must be 64 lowercase hex characters and no prefix (`0x`, `sha256:`). A bad encoding or two fields that disagree is `action_binding_malformed`. A missing required field is `action_binding_missing_digest`.
3. Sentinel recomputes sha256 of `proposed_action`:
   - string: exact UTF-8 bytes, not trimmed and not re-canonicalized
   - plain object or array: UTF-8 JCS
4. The recomputed hex must equal the signed digest (`action_binding_mismatch` otherwise). No `proposed_action` is `action_binding_missing_action`. A value that cannot be hashed is `action_binding_malformed`.

`action_hash`, mandate prose, and outer claims are not inputs to the digest comparison.

**Optional does not bypass an approval.** Recognition uses the same shape rule and does not require a valid signature: outer claims, or the parsed payload, or both. Once an item is an approval, every failure on that item forces **BLOCK** even when `verification` is `"optional"`. That includes an invalid signature, a malformed `raw_event`, a binding failure, a revoked / rotated / expired / not-yet-valid key, a role mismatch, a key missing from the manifest, and a `key_manifest_ref` with no manifest. A non-approval item keeps the previous split: `optional` does not force, and an unverifiable manifest on a required item stays UNCERTAIN. Missing approvals for an action kind are not inferred; only an item that presents an approval shape is covered.

**`claims_validated`.** The array is the signed payload's own `claims` when that value is an array of non-empty strings. It is never copied from outer `signed_evidence[].claims`. The HTTP field is omitted when the signed array is missing or empty, so responses for evidence that does not carry signed claims stay the previous shape. A malformed signed `claims` field is `signed_claims_malformed` and is not reported as validated. The portable verifier uses the same `readSignedClaims` function and the same code. Manifest role matching still intersects the key's roles with the outer claim strings. That match is not evidence that those strings were signed.

**Limits.**

- No BIP-340/Nostr verification. Those items stay `unsupported_signature_scheme`. There is no Ed25519 re-signing bridge.
- The preimage is the submitted `proposed_action`. Sentinel does not watch an executor. A component that runs the release has to hash the same bytes again. `package_digest` commits the validated request, including `proposed_action` when it is present. That hash is not the approval digest. Own JSON keys named `__proto__`, `constructor`, and `prototype` are kept. `src/package-digest.ts` and `scripts/verify-receipt.mjs` copy them onto a null-prototype object. A request without those keys keeps the previous digest.
- Legacy mandate normalization still drops `action.target` and `action.revision`. Those fields are not the binding preimage.
- The inline-manifest limit in §2.2 is unchanged. A matching digest shows that the signing key approved that digest, not that the caller-supplied manifest is an independent authority.
- `scripts/verify-receipt.mjs` evaluates this same predicate. It does not apply the inline key-manifest policy, and it does not require an approval when the evidence never presents an approval shape.
- Duplicate keys inside `raw_event` JSON are not rejected (`JSON.parse` keeps the last). String preimages are not Unicode-normalized.

---

## 3. Verdict forcing rules (F1)

Classification is **structured** (`severity` + stable `code`), never string
matching on human-readable reasons.

| Condition | Severity | Verdict effect (required items) | Code |
|---|---|---|---|
| Invalid signature over canonical payload | block | **BLOCK** | `evidence_signature_invalid` |
| Malformed / tampered `raw_event` | block | **BLOCK** | `evidence_malformed` |
| Unsupported signature scheme | block | **BLOCK** | `unsupported_signature_scheme` |
| Approval digest mismatch, missing, not inside the signature, unknown profile, or malformed binding | block | **BLOCK**, including when the item is `optional` | `action_binding_mismatch`, `action_binding_missing_digest`, `action_binding_digest_not_signed`, `action_binding_unsupported_profile`, `action_binding_malformed`, `action_binding_missing_action` |
| `claims` inside the signed payload is present but not an array of non-empty strings | block | **BLOCK** when the item is required | `signed_claims_malformed` |
| Signer key revoked / rotated / expired / not-yet-valid / role mismatch | block | **BLOCK** | `signer_not_authorized` |
| Signer key not present in manifest | uncertain | **UNCERTAIN** | `key_manifest_unverifiable` |
| Manifest referenced but not supplied | uncertain | **UNCERTAIN** | `key_manifest_unverifiable` |
| Internal verifier error | uncertain | **UNCERTAIN** | `evidence_verification_error` |
| `package_digest` uncomputable (with signed evidence) | — | ALLOW → **UNCERTAIN** | `package_digest_uncomputable` |

Design rationales:

- **Evidence invalid or signer unauthorized → BLOCK.** The evidence actively
  fails; treating it as "merely unsure" would let fraudulent evidence pass at
  reduced confidence.
- **Verifier cannot determine → UNCERTAIN, not BLOCK.** A missing manifest or an
  internal error is not proof of malice; blocking on verifier-side bugs would
  make the gate unusable and would be a false-positive factory.
- **Digest failure → UNCERTAIN.** Without the digest, the verdict is not bound
  to the package — the action-bound property is gone, so the response must say
  so rather than present an unbound ALLOW.
- **Downgrade-only.** No code path raises a verdict.
- **Approval failure → BLOCK, including when the item is optional.** Recognition does not need a valid signature. Signature, binding, and manifest failures on that item force BLOCK, so an optional flag cannot turn a broken or unauthorised approval into ALLOW. An internal error on a recognised approval is also BLOCK. The same codes on an item that is not an approval keep the previous required/optional split. `package_digest` failure stays UNCERTAIN.

---

## 4. Data handling

| Concern | Posture |
|---|---|
| Attacker-influenced text in responses | Error reasons truncated to 500 chars |
| Secrets in evidence | `signed_event.raw_event` is caller content; callers must not embed credentials. The API does not inspect for secrets — treat payloads as sensitive |
| Logging | Request-scoped logs include verdict/tier/duration; evidence bodies are not logged verbatim beyond truncated error reasons |
| Canonical verdict body | Deterministic projection (JCS), optional fields omitted when absent — third parties can hash/anchor byte-exactly |

---

## 5. Known limitations (explicit)

1. **Inline manifest trust** (§2.2) — the central v0 limitation.
2. **ed25519 only** — registry shape prepared for schnorr/bip340 and other
   schemes; not yet supported.
3. **No network manifest fetch** — `key_manifest_ref` is accepted but not
   resolved in v0.
4. **No rate-of-evidence abstractions** — evidence counts are bounded (≤50
   items), request body ≤ 1 MB.
5. **A verdict is not enforcement** — see §1.
6. **Action binding is shape-triggered** — see §2.7. It does not cover BIP-340, executor bytes outside `proposed_action`, or outer manifest role strings.

---

## 6. Reporting

Security issues: **support@thoughtproof.ai** — please include the request id
(`X-Request-Id`) and, where applicable, the `package_digest` so the exact
package can be discussed without sharing sensitive payloads.

---

## 7. References

- F1 ticket & steelman review (2026-08-02) — internal
- `docs/FAILURE-TAXONOMY-v0-2026-07-30.md`
- `docs/ADR-FRESHNESS-VS-VERIFIER-LATENCY-2026-07-30.md`
- `docs/ADR-SETTLEMENT-FRESHNESS-AT-EXECUTION-EDGE-2026-07-30.md`
- `scripts/verify-receipt.mjs` — portable offline receipt verification
