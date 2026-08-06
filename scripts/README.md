# Sentinel issuance scripts

## L1 (Ed25519 over JCS) — Stephen-checkable

| | |
|---|---|
| Profile name | **`rfc8785-canonicalize-utf8-v1`** |
| Applies to | `sentinel.verdict.canonical.v1` issued attestations |
| Produce | `X-Sentinel-Issue: sign` on `POST /sentinel/verify` or `POST /sentinel/attest` |
| Verify | `node scripts/verify-l1-attestation.mjs <file.json>` |
| Public keys | `GET /.well-known/validation-keys.json` |

**Rule:** verify Ed25519 over the **exact** `attestation.canonicalJson` UTF-8 bytes. Do not pretty-print or re-canonicalize unless you implement the profile bit-exactly.

## Validation artifacts (older boundary packs)

| | |
|---|---|
| Profile name | **`tp-json-sort-keys-recursive-utf8-v1`** |
| Sign | `node ../outreach/scripts/sign_validation_artifact.mjs` (repo-relative) |
| Verify | `node scripts/verify-validation-artifact.mjs` |

These two profiles are **different algorithms**. Do not mix names or verifiers.

## Offline issue (dev)

`node scripts/offline-issue-l1.mjs <sentinel-raw.json> <priv.pem> <pub.pem> <out.json>`
