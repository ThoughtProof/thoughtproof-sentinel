# Security Model — ThoughtProof Sentinel

**Scope:** `sentinel.thoughtproof.ai` verification API, including F1 action-bound
evidence verification (`signed_event`, `package_digest`, `proof_strength`).
**Last updated:** 2026-08-02 (post-F1, PR #19)

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
| The evidence bytes carry a valid ed25519 signature over the JCS-canonical payload | Signature recomputation at verify time, **server-side only** (§2.6) |
| The verdict is bound to the exact request package (not a paraphrase, not "current room state") | `package_digest` = sha256 over JCS-canonical request, emitted in `meta` |
| A declared signer key is listed as `active` in the *supplied* manifest, within time bounds, with matching roles | Manifest consistency check |
| A third party can recompute the `package_digest` offline from the accepted request | `scripts/verify-receipt.mjs` (zero-dependency); requests with unknown fields are rejected at ingest (§2.5). **The portable script does not currently re-verify ed25519 signatures offline — see §2.6.** |

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
| `recomputed` | Every required `signed_event` was independently signature-verified (and manifest-consistent, where a manifest was supplied) |
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
| `signed_evidence` present, no trusted keys supplied | 1 |
| `signer_pubkey` not in trusted set / key_id mismatch | 1 |
| Missing/malformed `raw_event` | 1 |
| Invalid ed25519 over JCS-canonical payload | 1 |
| All requested checks pass | 0 |

**Dependency note.** Signature and digest recompute require the same
`canonicalize` package the server uses (install via `npm i` in this repo).
Matching the server byte-for-byte matters more here than a second pure-JS
JCS that could silently diverge.

**Still separate (not F5).**

- Signed server responses (server signs its own output envelope).
- Registry-backed key rotation / ERC-8004 authority.
- Authoritative revocation freshness (transparency log / on-chain).

---

## 3. Verdict forcing rules (F1)

Classification is **structured** (`severity` + stable `code`), never string
matching on human-readable reasons.

| Condition | Severity | Verdict effect (required items) | Code |
|---|---|---|---|
| Invalid signature over canonical payload | block | **BLOCK** | `evidence_signature_invalid` |
| Malformed / tampered `raw_event` | block | **BLOCK** | `evidence_malformed` |
| Unsupported signature scheme | block | **BLOCK** | `unsupported_signature_scheme` |
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
