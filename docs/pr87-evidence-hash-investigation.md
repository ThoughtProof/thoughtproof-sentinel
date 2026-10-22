# PR #87: evidence hash boundary investigation

Date: 22 October 2026. Source revision:
`dd5efc5d16cbc84fb34e6d5318ac6eb37fcb8aeb` in
`ThoughtProof/thoughtproof-sentinel`, draft PR #87.

## Finding and scope

The HTTP/native divergence is confirmed locally with synthetic evidence. At
the source revision, `validateVerifyRequest` strips leading and trailing
ECMAScript whitespace from evidence. The HTTP handler passes that validated
request to `verify`. Direct native `verify` calls bypass that step, and
`runTradeRiskGate` hashes its evidence argument verbatim. Consequently an
otherwise identical request can produce different HTTP and native receipts.
Leading/trailing LF, CRLF, tabs and Unicode trim whitespace reproduce it,
including a controlled positive ALLOW. Internal line breaks alone do not.

The two original 18 October companion fixtures and the actual Cycle client
source were not accessible for this investigation. Searches of accessible
GitHub repositories and available files did not locate them. The PR documents
a client requiring matching request identity, checked risk inputs, recomputed
fractions and evidence hash before accepting ALLOW. This investigation tests
the actual Sentinel HTTP handler and native engine; it does **not** execute or
invent that separate client's guard. Whether its current hash implementation
expects raw text, ECMAScript trim or another language's strip remains unverified.
The recorded two mismatches are consistent with this reproduced mechanism;
they have not been individually replayed.

## Shared contract

Retain the established HTTP behavior, rather than change every existing HTTP
request digest, attestation input and consumer expectation:

1. Decode the JSON request and take its `evidence` string, not the JSON wire
   representation or the entire HTTP body.
2. Normalize with exactly ECMAScript `String#trim`. This is an idempotent
   removal of leading/trailing whitespace, not general Unicode normalization.
3. Validate the original input's type, nonempty-after-trim requirement and raw
   size limit as before. Unknown fields and malformed risk operands still fail.
4. Supply that same normalized text to risk checks, the evaluator and source
   reference/provenance checks. A hash-only normalization is insufficient.
5. `evidence_sha256` is the lowercase 64-character SHA-256 hex digest of the
   normalized text's UTF-8 encoding. Do not include surrounding JSON quotes.

There is no internal whitespace folding, LF/CRLF conversion, NFC/NFKC
normalization, JSON parsing/reserialization or sorted-key transformation of
the evidence text for this hash. SHA-256 evidence binding is separate from
JCS canonicalization of the full validated request for `package_digest` and
from the attestation's Keccak-256 evidence hash. The unsigned risk metadata
does not become independently attested by this change.

For cross-language implementations, the ECMAScript trim code points are
U+0009–U+000D, U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028–U+2029,
U+202F, U+205F, U+3000 and U+FEFF. In particular U+0085 and U+200B are
preserved. Do not substitute an untested Python `strip()` or language-specific
whitespace class. Portable synthetic vectors are in
[`pr87-evidence-hash-vectors.json`](pr87-evidence-hash-vectors.json).

A compatible client can normalize once before constructing the outgoing
request and hash exactly the evidence string it sends. It must continue to
require matching receipt schema/status, request ID/mode/tier, checked order
facts and independently recomputed fractions before accepting ALLOW. A risk
pass alone is not authorization. Missing/mismatched receipts, BLOCK,
UNCERTAIN, transport errors and timeouts remain denials. Do not try raw and
trimmed hashes as alternative acceptance paths, or waive hash comparison.

## Correction

`normalizeEvidenceText` centralizes the existing HTTP trim operation. The
HTTP validator calls it at the same point as before, so accepted HTTP payloads
and all their downstream validated data remain unchanged. Native `verify`
copies its input and applies that helper before risk checks and evaluation.
The low-level `runTradeRiskGate` continues to hash the exact argument supplied
by its caller; direct low-level users must supply the normalized consumed
text. Neither the request nor the caller's evidence string is mutated.

No risk limit, tolerance, response schema version, provenance requirement,
score threshold, promotion rule, routing, timeout or retry policy is changed.
Native entry still expects a validated request; this small repair is not a
replacement for HTTP validation of all other fields. Future qualification
harnesses should call the real validator or HTTP entry point rather than
assume native results establish transport compatibility.

## Reproduction and validation

The new `src/trade-risk-http-contract.test.ts` starts a TCP server bound only
to `127.0.0.1` and sends JSON POST requests to the actual HTTP handler. Auth,
validation, the native engine, installed router/evaluator, evidence processing
and response JSON assembly run. Provider `fetch` is intercepted and accepts
only the synthetic `https://offline.invalid/v1/chat/completions` endpoint.
Payments, Redis, attestation keys, export keys and Stripe configuration are
disabled within this isolated test fixture. No external model is contacted.
These test-only settings do not alter any runtime/deployment configuration.

The completed regression suite was first run against unchanged application
code: 18/26 passed and 8 failed on the native evidence hash assertions. The
same 26 tests pass with the correction. They cover:

- Positive ALLOW with unchanged text and four outer-whitespace variants;
  matching HTTP/native receipt identity, operands, arithmetic, quotes and
  evaluator requests; caller input preserved.
- Distinct hashes for internal LF/CRLF, literal escapes, spacing, Unicode
  composition, zero-width space and U+0085, preserving evidence integrity.
- Excess risk (100 USDT actual versus 50 permitted), leverage violation,
  wrong-side stop and macro halt remaining BLOCK with zero provider calls,
  even in shadow mode; contradictory JSON order facts also remain blocked.
- HTTP rejection of whitespace-only/non-string/oversized evidence, numeric
  strings, caller-supplied risk ceilings and unknown top-level fields, and
  rejection of an invalid API key before inference.
- Invalid required evidence signatures still overriding a controlled model
  ALLOW with BLOCK, with a package digest over the exact validated request.
- Malformed assessments staying UNCERTAIN and model BLOCK remaining BLOCK
  after a matching deterministic pass.

The complete native suite passes **915/915** (889 existing plus 26 new tests).
The full TypeScript check still exits 2 with **96 existing diagnostics**;
normalized diagnostic comparison adds/removes none. The project's ADR-0020
path filter has no matching diagnostics. ADR-0020 MJS/TS parity passes 12/12.
These are offline implementation results, not model-quality measurements.

Commands:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test -- src/trade-risk-http-contract.test.ts
npm test
npm run typecheck
node scripts/adr0020-parity.mjs
```

## Remaining full HTTP/client qualification

PR #87 remains unqualified on the evidence available here. Its native Sol
9/9 and Luna 8/9 observations are not replaced or expanded by these controlled
tests. Required next evidence:

1. Pin and inspect the actual Cycle client and native harness revisions.
   Compare their outgoing evidence and expected hash byte-for-byte against
   the shared vectors, including LF/CRLF and cross-language whitespace edges.
   Replay the two original mismatch fixtures through the actual client.
2. Run the real client against the local candidate HTTP handler with canned
   completions. Include a cited positive ALLOW and fail-closed controls for
   missing receipt, wrong hash, ID/mode/tier, checked input or arithmetic,
   malformed JSON, non-2xx responses, timeout and stale/replayed responses.
   Preserve the client's current eight-second deadline and no-bypass rules.
   This can be done without any model calls once the source is available.
3. Pin a non-production candidate endpoint, vendor archive, model route and
   environment configuration. Platform routing, authentication/payment paths,
   model identity and serialization must be checked against that exact
   deployment. Existing CI aimed at production does not qualify this branch.
4. With separate authorization for model calls, obtain bounded full HTTP/client
   observations on independent controls, including the inclusive short/equality
   case that Luna missed. Measure the entire client deadline, including HTTP
   overhead, rather than only local model time. Reused known cases do not
   estimate natural false-block rates or held-out model quality.
5. Resolve or explicitly scope the generic numeric explanation binder's
   unverified-reason limitation. Preserve raw reasons, exact source references,
   restrictive verdicts and diagnostics; do not suppress the checks to pass.

No live or paper trading process, OpenClaw/Hermes process, production resource,
model provider configuration or production branch is changed by this work.
Do not open/update the existing PR automatically during this no-model-call
task: `.github/workflows/action-authorization-suite.yml` matches its engine
changes and may execute paid model requests against production. A separate
review branch can carry this correction without opening a PR; no branch push
workflow here targets non-main branches. Preview provisioning, if automatic,
is not evidence that any qualification request was executed.
