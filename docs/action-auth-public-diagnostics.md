# Public action-authorization diagnostics

The GitHub Actions artifact is public. `sentinel.action-auth-suite.diagnostics.v2`
is a diagnostic projection, **not the original receipt or a verifiable signed
export**. The version change is intentional; consumers must not require the
removed text fields.

## Publication boundary

The committed synthetic fixture snapshot is reviewed public input. Its hash,
the actual request hash, runner SHA and run ID identify the experiment. The
response is untrusted, even for a synthetic request. Do not use this public
workflow for private/customer fixtures. A repository review must keep fixtures
public; the projection is not a general-purpose DLP filter for source files.

The archive retains:

- Valid receipt IDs and verdicts, finite confidence/scores, HTTP status and
  runner-computed classifications/counters.
- Closed promotion/cascade codes, internal/mapped/public verdicts, kind and
  kind-source enums, promotion/proof flags, hexadecimal release SHA and reviewed
  policy identifiers. The server-reported release remains distinct from the
  runner SHA; it does not independently prove a Vercel account/alias mapping.
- Reviewed model aliases, step IDs/predicates, quote source/match mode,
  deterministic objection source, engine-budget and evidence-bind diagnostics.
- For a nonempty exact quote: a **runner-computed** `quote_evidence_span` with
  `start`/`end` UTF-16 offsets into that case's public fixture `evidence`.
  Reconstruct with `evidence.slice(start, end)`. Absent spans may mean a null
  quote or a non-exact match; consult the retained quote provenance. A span
  supplied by the server is never trusted.
- Typed attestation hashes/billing metadata and the original export digest
  as a correlation reference only.

Raw reasoning, criteria, quotes, agent identity echoes, canonical bodies,
signatures and key IDs are omitted. Do not attach an old signature to rewritten
canonical content. Full model prose requires a separately authorized private
trace; this change neither creates nor publishes one. Criteria can be inspected
in the source corresponding to the reported release and step ID.

Unknown fields and invalid values are omitted. `dropped_fields` uses fixed
schema paths and `*` for unknown keys; raw key names may themselves contain
private data. New model aliases, policy versions or reason codes require a
reviewed allowlist update. The schema rejects prose in nominally scalar slots.
URL credentials/path/query/fragment and malformed runner metadata are omitted
from public output. Original request routing is unchanged.

## Safety and validation

Requests, retries, fixtures, original response classification, `scoreRows` and
`resolveGate` remain unchanged. Publication projection happens after gate
calculation; it also covers duplicate rows, score failure lists, console output
and step summaries, including non-2xx and transport errors. Unknown error text
becomes a fixed `redacted_error` marker. `false_ALLOW=0`,
`FALSE_BLOCK_BASELINE=0` and degradation handling are unchanged.

`src/action-auth-suite-privacy.test.ts` uses mocked HTTP responses and synthetic
canaries only. It checks nested/opaque payloads, malicious key names, invalid
scalar values, known-key echoes, quote offsets, duplicate outputs, HTTP errors,
transport errors and safety-gate precedence. No live model call is needed.

Do not dispatch/rerun the live workflow to validate this change. A PR update can
trigger live production requests; keep `[skip ci]` in its commit message until
that execution is separately authorized. This marker does not control Vercel
Git deployments. Confirm the Vercel team, project and environment before
advancing a branch that automatically deploys.
