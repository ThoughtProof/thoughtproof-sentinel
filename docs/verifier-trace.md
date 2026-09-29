# Preserve the deciding evaluator's objection

An observed research checkpoint returned UNCERTAIN while its visible steps were
all faithful and its prose said the plan was fully supported. The cascade marker
reported primary HOLD / secondary ALLOW. `runSentinelCascade` selected
`secondary ?? primary` for the legacy surface, then replaced its verdict with
the combined cascade verdict. The primary evaluation was discarded at that boundary.

The correction carries both actual ItemResults through that boundary and exposes
their normalized findings in `meta.verifier_trace`. The existing cascade policy,
top-level verdict, confidence, reasoning and objections are unchanged. No new
model request is added. This fixes lost provenance; it does not establish that
a primary HOLD was justified or reduce false stops by itself.

## Contract

- `schema_version`: `sentinel.verifier-trace.v1`.
- `signature_scope`: `unsigned_diagnostics`. M1 does **not** sign this field.
  A valid M1 signature does not authenticate these diagnostic stage details.
- `cascade_reason`, `internal_verdict`, `legacy_surface_stage` identify the actual
  cascade outcome and which evaluator supplied the legacy surface. They are
  taken from structured runtime data, never parsed from model-written prose.
- `engine_verdict` precedes possible evidence-middleware downgrades.
  **Only `response.verdict` is the final public verdict.**
- `retained_primary_restriction` identifies a primary restriction retained by the
  known cascade policy. It does not claim the objection is true.
- Each stage distinguishes completed, unavailable and not invoked. Unavailable
  findings are null/empty, including a failed secondary hidden by the vendored
  primary-HOLD branch's `secondaryInvoked` flag. Raw error messages are not exposed.
- Each step uses the same quote normalization and numeric evidence binding as
  the legacy response. The stage summary also passes numeric evidence binding;
  the new diagnostic field must not resurrect a stripped numeric claim.
- `reasoning_source` describes evaluator prose, a generated surface notice,
  criterion-only fallback or evidence-binding rewrite. `missing_reason_steps`
  and `evaluator_reasoning_present` identify omitted original explanations.
  The presence of prose does not establish its accuracy or repair sufficiency.

For primary HOLD / secondary ALLOW, inspect the primary stage. If its reasoning
is absent, obtain the verifier detail or clarify the disagreement. Do not invent
a new task requirement and do not override HOLD merely because secondary steps
pass. A false BLOCK with criterion-only explanations is still an unresolved
repair-guidance limitation.

The trace is absent on deterministic short-circuits and engine-budget exits.
Their existing gate/budget metadata remains the source of the stop. Historical
responses cannot retroactively recover discarded primary details. The v1 M1
projection remains byte-compatible for unchanged verdict data. A future signed
trace would require its own versioned signing contract.

## Verification and limitations

`src/engine/cascade-trace.test.ts` mocks only inference and exercises the real
vendored 0.8.10-tp.2 cascade policy. It covers retained HOLD, rejected BLOCK,
provider failure, omitted reasons, quote validation, numeric objection binding,
solo evaluation, middleware downgrades and unchanged canonical projection.
Q-03/Q-04 HTTP fixtures are original saved responses. Their hidden internal
evaluations were not available; tests label newly supplied internal fixtures as
synthetic, not recovered provider evidence.

Run offline:

```sh
node node_modules/vitest/vitest.mjs run src/engine/cascade-trace.test.ts
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
```

Direct Node commands also work from a checkout whose directory contains `:`.
Neither tests nor this patch call the live verification API. Actual false-stop
and repair improvements require a separately recorded post-release qualification
and matched comparison; the old six-probe failure remains part of the evidence.
