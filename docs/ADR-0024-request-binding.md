# ADR-0024: Server-computed request binding on signed exports

**Status:** Proposed. Owner GO for this build is "Go, weiter" after MCP #52 offline acceptance at `faf89b6492d198da7daac41cb13e5257ebf03823`. Do not merge without review.
**Decider:** Raul

## Context

ThoughtProof MCP checks `requestHash` on every present Sentinel export canonical before a signed ALLOW may execute and before any other signed non-BLOCK verdict may escalate. Sentinel did not issue that field. `mandateDigest`, `actionDigest`, and `packageDigest` do not cover the claim, the evidence, or unknown body keys.

The MCP contract is `docs/sentinel-request-binding.md` in thoughtproof-mcp, profile `thoughtproof.mcp.request_binding.v2`. Shared vectors live in `test/fixtures/request-binding-v2.json` (copied from that repo). Those vectors, and the committed v1/v2 export fixtures that use kid `tp-sentinel-export-ed25519-2026-09-vector`, are synthetic. They are not production receipts.

ADR-0022 kept `releaseId`, `policy`, and `potCli` off v1 so existing M1 digests would not move. This binding is a separate decision: the MCP gate reads `requestHash` from every present canonical, including v1. Putting it only on v2 would leave a signed v1 ALLOW unbound.

## Decision

1. **Profile.** `thoughtproof.mcp.request_binding.v2`. No new artifact schema id. `signed_export` stays `sentinel.verdict.canonical.v1`. `signed_export_v2` stays `sentinel.verdict.canonical.v2`. The envelope domain stays `thoughtproof.sentinel.export.v1`. `apiVersion` stays `sentinel-api-0.1.0`.
2. **Preimage.** UTF-8 bytes of the RFC 8785 JCS of `{ "profile": <profile>, "request": <parsed JSON body> }`. The field value is `sha256:` plus lowercase hex. Sentinel hashes the object the HTTP parser produced. It does not trim, case-fold, or Unicode-normalize. Key order and insignificant whitespace do not matter. Whitespace inside strings does. Absent is not null. Unknown keys are kept. Headers and credentials are outside the hash, including `X-Sentinel-Key` and `PAYMENT-SIGNATURE`.
3. **Encoder.** `src/request-binding.ts` matches the MCP encoder at the commit above, including lone-surrogate rejection. It is not the `canonicalize` package. That package still serializes the verdict canonical and the package digest. A key named `__proto__` is read as an own data property so it stays in the preimage.
4. **Signed field.** When the preimage can be built, `requestHash` is written onto the v1 and v2 canonical bodies before signing. The canonical digest is SHA-256 of that JCS string, and the Ed25519 signature covers the string, so the hash is inside both. The same string is used on both formats. An export whose canonical does not carry that exact hash is omitted.
5. **Fail closed.** A lone surrogate in a key or a string value, or any other preimage failure, is HTTP 400 `INVALID_REQUEST` before payment and before the engine. There is no verdict and no signed export. That path cannot be ALLOW. UNCERTAIN, engine errors, HTTP 401, 429, and 5xx are unchanged and are not turned into ALLOW. The existing F3 top-level whitelist still rejects unknown fields, including a client `requestHash`, with 400 and no export. Nested fields the validator already accepts stay in the raw-body hash even when a later normalizer drops them from the engine input.
6. **Client hash.** A field named `requestHash` inside the body is more body content. It is never copied into the signature.
7. **Unchanged commitments.** `mandateDigest`, `actionDigest`, and `packageDigest` stay as they are. They do not satisfy `requestHash`.
8. **Historical exports.** Builders that do not receive a server hash omit the field. The committed M1 v1 and v2 vectors are not regenerated and still verify. The portable verifier does not require the field, because requiring it would reject those vectors. MCP fail-closes when a new signed ALLOW omits it. New verify responses that are signed include it, so their v1 digest is not the pre-binding digest of the same verdict.
9. **What this does not bind.** `situation` is not part of the Sentinel body. This hash does not cover the later RV request.

## Non-goals

- No new signing key and no change to key handling.
- No change to `src/engine/local-command.ts`, BLOCK precedence, or the F3 whitelist.
- No merge, deploy, or release is part of this decision's implementation step.
