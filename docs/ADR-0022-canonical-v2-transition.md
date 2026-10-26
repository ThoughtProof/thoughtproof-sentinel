# ADR-0022: Canonical verdict v2 and the v1 transition

**Status:** Proposed (2026-10-26). Do not merge without Raul GO.
**Decider:** Raul

## Context

`signed_export` commits an Ed25519 signature to `sha256` of the JCS bytes of `sentinel.verdict.canonical.v1`. External verifiers (PriorSeal, invinoveritas) and the vectors in `scripts/fixtures/m1-export/` pin those bytes. Adding a field to the v1 body changes the digest.

`meta.promotion.release_id`, `meta.promotion.policy`, and the installed pot-cli version are already public (commit SHA, ADR policy id, semver on `GET /sentinel/health`). They are not in the signed body, so a receipt cannot show that the signature covers the release that produced the verdict.

## Decision

1. **Do not extend v1.** `buildCanonicalSentinelVerdict` stays a strict projection. `signed_export` remains that v1 body. Existing M1 vectors are not regenerated.
2. **Add `sentinel.verdict.canonical.v2`.** The v2 body is the v1 projection plus optional `releaseId`, `policy`, and `potCli`. Optional fields are omitted when absent, never null (JCS).
3. **Sources.** `releaseId` and `policy` are copied from `meta.promotion.release_id` and `meta.promotion.policy` when those values are non-empty strings. `potCli` is `getPotCliVersion()` after the publishable-semver check (same predicate as the public receipt). `unavailable`, paths, and free text are omitted. The envelope domain stays `thoughtproof.sentinel.export.v1`; the inner `artifactSchema` is what changes.
4. **Dual issue.** While the signer is configured, the verify response carries `signed_export` (v1) and `signed_export_v2`. `verifySignedCanonicalExport` accepts both schemas and rejects any other `artifactSchema`. `scripts/verify-canonical-export.mjs` takes `--schema v1|v2|all` (default `auto`). A field is present when the key exists. null, a string, an array, or any other non-object is `invalid_export`. `signed_export` must be v1 and `signed_export_v2` must be v2 (`schema_field_mismatch`). An input that has top-level envelope fields and `signed_export*` keys is `ambiguous_input` and is rejected. Requesting v2 fails if that export is missing or invalid, including a v1 body in the v2 field. `all` and `auto` verify every present export and fail if any present export is invalid. The result lists `verified_schemas`. A full API response is not verified as v1 alone.
5. **Fail-safe.** Building or signing v2 is try/catch. Any error omits `signed_export_v2` and does not throw into the verify handler. The verdict, the promotion, and the v1 export are unchanged. v2 is provenance only. It is not an input to ALLOW, BLOCK, or UNCERTAIN.
6. **Public receipt.** `meta.pot_cli` is on the action-authorization suite allowlist only as a semver of at most 64 characters. It is the same non-sensitive version string already returned by `/sentinel/health`. `signed_export_v2.canonical` stays off that allowlist because it still contains reasoning and objections.

## Consequences

- Verifiers that pin v1 keep working on `signed_export`.
- Verifiers that want release, policy, and pot-cli provenance verify `signed_export_v2`.
- A pot-cli bump changes future v2 digests and does not change v1 digests.
- `meta.pot_cli` is attached on the API response, not inside `src/engine/**`.

## Non-goals

- No salted mandate or action digests.
- No `checks_performed` / `gate.checked` (that would touch `src/engine/**`).
- No principal-signed mandate and no public copy of `canonical`, `signature`, or `keyId`.
- No new path that upgrades a verdict to ALLOW.
