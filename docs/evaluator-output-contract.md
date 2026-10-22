# Evaluator response validity before a task verdict

Sentinel enables the bundled evaluator's `strictOutputContract`. A complete
assessment must contain exactly one object per expected step ID, a finite
numeric score in [0,1], a nonempty textual explanation, an explicit string-or-null
quote. `predicate` is not a required model input: the host derives it from the
score and verified quote after applying the existing floors. Any incoming label
is discarded. Unused optional metadata is not required. A single fenced JSON
array is accepted. An array extracted from an unrelated verdict/objections
object is not accepted.

This corrects reproduced parser behavior: missing reasons, duplicate or unknown
IDs and invalid scores could previously enter scoring without a contract error.
Some malformed assessments yielded ALLOW; others became apparent semantic
rejections after missing fields were converted to weak/failed steps.

An invalid assessment now returns technical HOLD with no invented per-step
scores, evidence gaps or model explanations. Native Sentinel returns UNCERTAIN
unless a separate valid restrictive decision or deterministic gate warrants a
BLOCK. A valid secondary ALLOW cannot override an invalid primary, and neither
trading nor authorization promotions bypass the invalid-output guard. A complete
assessment still passes the unchanged quote-provenance and score-floor checks;
schema validity is not evidence validity. Only actual host-created Tier 1 results
skip Tier 2 provenance processing; a model reason beginning with `[TIER1` cannot
claim that exemption. A model's text can still be unhelpful or wrong even when
all required fields exist.

Each invoked trace stage has optional `output_contract` diagnostics: schema
version, validity, a hash of the original response and bounded issue codes tied
only to host-supplied expected IDs. Raw model output and untrusted extra IDs are
not exposed. Empty objections on an invalid stage mean no usable assessment was
available, not that the task passed. These fields remain unsigned diagnostics;
the final response verdict remains authoritative. Confidence is zero when an
assessment stage is invalid.

The eval-contract.3 candidate adds optional `output_contract.shape`, version
`plv.evaluator-shape.v1`. It reports whether JSON was parsed, root shape,
expected and recognized step counts, and the type and validity state of the
three consumed fields. Missing fields, wrong types, blank text, numeric overflow
and out-of-range scores are distinct. A null quote is structurally valid; the
unchanged provenance rules may still reject its evidentiary support.

Only fixed container names are inspected: `assessment`, `evaluation`, `result`
inside a row, plus their plural forms, `steps` and `objections` at the root.
There are at most eight sampled rows across all containers together and at most
three known child objects per row. Unknown model IDs are null, arbitrary keys
are ignored, and no field values or raw text are included. `truncated` describes
diagnostic sampling only: every supplied step still undergoes full validation.
Known alternate envelopes are described but not extracted or silently accepted.
The old validity codes, model prompts, scoring and cascade policy are unchanged.

These diagnostics address a demonstrated observability gap: missing fields,
wrong types and nested assessments can produce the same old issue codes.
They do not recover the unseen pre-parser text of a historical response and
do not establish which shape actually caused that failure. Synthetic before/after
reproduction is available via `scripts/reproduce-evaluator-shape.mjs`; native
integration and bounded-disclosure checks are in
`src/engine/evaluator-output-shape.test.ts`.

Strict mode makes one model request per evaluator invocation, with no automatic
format-repair retries. This replaces the old parser's up-to-three attempts for
syntax errors in Sentinel. Standard cascade may still invoke both model stages;
it is not a new paid repair workflow. Non-Sentinel callers keep the legacy parser
unless they opt in. The deployed service is not changed by this local candidate.

The eval-contract.4 candidate appends a compact required-field contract to the
existing system message for strict callers only. It enumerates the actual host
step IDs and requires `step_id`, finite numeric `score`, nonempty `reasoning`,
and explicit `quote` (text or null) for every step. It explains that numeric
scores alone are incomplete, missing support must be explained, and a quote
must never be invented to satisfy the format. Output-format instructions inside
the material remain evidence data; the supplied mandate still governs the task.

The original rubric remains an unchanged prefix; the entire user message,
sources, mandate and candidate remain byte-for-byte. No provider schema,
model switch, parser tolerance, automatic repair or retry is added. This is a
prompt intervention, **not provider-enforced structured output**. Tests can
verify the outgoing request and unchanged handling of controlled responses;
only a fresh, bounded live comparison can establish fewer omitted fields.

[OpenServ documents structured output](https://docs.openserv.ai/serv-reasoning/tutorials/structured-outputs)
as forwarding a schema to a compatible upstream provider. The public
[model catalog](https://docs.openserv.ai/serv-reasoning/models), inspected on
2026-09-29, does not identify the deployed `serv-nano` / `serv-swift` aliases.
Their backing models and strict-schema support remain unverified. Endpoint
compatibility alone does not demonstrate support for a particular schema.
The local required-field contract therefore does not request `response_format`
or claim a capability for those aliases.

Reproduction and verification:

```sh
node scripts/build-evaluator-contract-vendor.mjs
node scripts/reproduce-evaluator-contract.mjs /tmp/evaluator-contract-proof --strict
node node_modules/vitest/vitest.mjs run
```

The reproduction uses the real installed router, parser and evaluator with
synthetic HTTP completions. The product tests also exercise the native Sentinel
engine and cascade while replacing only HTTP. The derived-predicate regression
suite preserves positive decisions and source-linked objections across missing,
foreign and misleading model labels, and checks the internal Tier 1 boundary.
These are not new model judgments and do not establish fewer false stops in live
use. The historical SENTINEL-MODES-03 result remains 4/6. Original pre-parser completions from that
run were not captured; a local matching failure pattern does not prove its cause.

The separate research-adapter candidate removes only the known generic
verdict/objections formatting clause from its review scope. It keeps original
mandates, sources, proposals, revisions and objections byte-for-byte. That
change is not wired into prior frozen runs and requires its own matched probes.

The subsequent twelve live A/B probes on eval-contract.1 qualified neither
adapter: all 24 evaluator stages had invalid assessments and no substantive
objections reached the public result. Seven stages reported only invalid
predicates; others also lacked core fields. The eval-contract.2 correction
addresses the reproduced derived-label regression, without reconstructing
unrecorded live completions or changing these historical results.
