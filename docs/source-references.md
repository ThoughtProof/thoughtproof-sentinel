# Exact source references for trade execution

The previous historical qualification returned valid assessment JSON but rejected
many model-written quotes because they were absent from the designated source.
`0.8.12-eval-contract.2` adds an explicit alternative to copying a passage: the
evaluator selects its host-generated address, and the host resolves that address
to the exact original text before running the existing provenance and score rules.
This does not make a source assertion true or relevant, recreate missing reasoning,
or establish the temporal origin of reconstructed evidence.

## Contract

Native Sentinel enables `sourceReferences` only for `trade_execution`. Other
modes and legacy evaluator callers retain their prior behavior. It requires the
existing strict output contract; `claim` and `evidence` in the public request are
unchanged. The original prompt, sources, criteria and scoring rubric remain in
place, with serialization instructions and a data-only catalog appended.

The catalog indexes complete nonblank source lines, trimming only boundary
whitespace. It contains at most 256 passages, each at most 2,048 UTF-16 code units.
Long lines and excess passages are omitted from the catalog, never from the source;
the existing direct-quote path remains available. Reference IDs include a source
marker, original line number and source hash prefix. References are resolved only
against the current request's in-memory catalog. Full source SHA-256 and exact
zero-based, end-exclusive UTF-16 offsets are retained in unsigned audit metadata.

Every assessment still needs `step_id`, `score`, `reasoning`, and `quote`:

- With `quote_ref: "<catalog address>"` and `quote: null`, the host copies only
  that selected passage. It also derives `quote_location` from the original source.
- With a non-null `quote_ref` and a quote string, the string must equal the selected
  passage exactly. A valid reference cannot repair a conflicting or fabricated quote.
- With absent/null `quote_ref`, the legacy direct string or explicit null quote
  follows the unchanged provenance checks. No reference is selected automatically.
- Unknown, stale, non-string, or wrong-source references invalidate the assessment.
  The result is technical HOLD / public UNCERTAIN, not an invented substantive
  objection. No repair inference or retry occurs.
- The selected source must match the gold step's existing `EVIDENCE_SOURCE`: trace
  for trace steps, answer for answer-consistency steps. Source routing is unchanged.

The model remains responsible for judging the entire relevant evidence and
counter-evidence. A source reference does not raise a low score or bypass the
short-quote floor. Genuine contradictions remain BLOCK. Invalid primary output
cannot be promoted by a secondary ALLOW. The generic numeric binder is unchanged
and still cannot independently establish typed stop-risk arithmetic from prose.

## Audit and validation

`meta.verifier_trace.stages[].output_contract.source_references` records catalog
size/truncation and up to 128 host-derived citation records. Each records status
(`resolved`, `direct_quote`, `none`, `invalid`), designated source, full source
hash, and valid address/offsets where applicable. Unknown model addresses and
rejected text are not exposed. This metadata is unsigned; the existing signed
decision projection is unchanged. The quoted source text still follows the
normal public quote surface and its checks.

`src/engine/source-references.test.ts` exercises the real installed router,
parser, provenance, cascade and native response surface with synthetic HTTP
completions. It covers source isolation, stale addresses, conflicting quote text,
missing required fields, low scores, explicit negative evidence, primary/secondary
handling, Unicode/CRLF offsets, bounded catalogs and legacy/non-trade callers.
These local tests are distinct from the preregistered matched preview comparison;
neither is a natural-trade overblocking estimate or a profitability result.

## Format follow-up

The matched .2 preview failed all eleven candidate response contracts; ten lacked
`reasoning` and `quote`, and one was not valid JSON. No reference resolution was
observed. Version .3 retains those failed results and adds the complete response
schema after the input catalog. The parser remains strict, with no field aliasing
or repair retry. A separate preregistered three-control gate is required before
any further historical calls.
