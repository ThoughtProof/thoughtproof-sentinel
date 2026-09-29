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

Strict mode makes one model request per evaluator invocation, with no automatic
format-repair retries. This replaces the old parser's up-to-three attempts for
syntax errors in Sentinel. Standard cascade may still invoke both model stages;
it is not a new paid repair workflow. Non-Sentinel callers keep the legacy parser
unless they opt in. The deployed service is not changed by this local candidate.

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
