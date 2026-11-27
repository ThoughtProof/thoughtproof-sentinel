# prompt comparison on the #140 extractor

This pilot is a **prompt comparison on the #140 extractor**. It is not a comparison against the production critic.

## Why the strong critic is not arm A

The strongest critic already in the tree is pot-cli `runCritic` (`node_modules/pot-cli/src/pipeline/critic.ts`). It scores proposals from 1 to 10, calls a provider unless `dryRun` is set, and the dry-run result is a fixed string. The function takes no tool list.

The production verify path is `runSentinelCascade` (`src/engine/cascade.ts`). `evalOptions` is `mode`, `maxTokens`, and an optional nano-step flag. No tools are passed. The public map is `mapVerdict` (`src/engine/verdict.ts`): for `trade_execution`, `trade_reasoning`, and `action_authorization`, `CONDITIONAL_ALLOW` becomes UNCERTAIN. `runAuthorizationGate` (`src/engine/authorization-gate.ts`) hard-BLOCKs only amount overshoot, recipient mismatch, and unlimited allowance, and stays silent otherwise. It does not decide a pending second approval.

Those hosts do not read this adapter's JSON. Using either as arm A would change the model, the schema, the gate, and the tool set. Arm B would then differ by more than one instruction. Arm A therefore stays the frozen extractor (`experiments/trade-contract/prompt.ts`: the model does not decide ALLOW or BLOCK; the local contract does). The extractor has no tools. Arm B gets that same request, with one extra paragraph.

## Host

Both arms call `decideCascade` with a null secondary exchange (`comparison-run.ts`). A schema-valid primary answer stands, including ALLOW (`adapter.ts`, `if (!first.failure) return first.result`). `finish` in `evaluate.ts` maps contradicted to BLOCK, invalid structure or `not_verifiable` to UNCERTAIN, and otherwise ALLOW. `downgrade` rewrites only ALLOW to UNCERTAIN when `downgradeAllow` is set (`adapter.ts`).

After that frozen decision, the same host function runs for A and B. It never turns a non-ALLOW into ALLOW. It withholds ALLOW when a grounding row is `open` or `violated`, when a `met` quote is missing, does not locate, states a pending condition, or shares no content word with the clause. `open` may set `evidenceQuote` to null, because absence of a document cannot be quoted.

The previous B filter, which dropped ungrounded objections and could turn BLOCK into ALLOW, is only `replayLegacyDrop`. Its rows are labelled `legacy-drop-replay`. It is not the primary B result. On the recorded pilot-01 payload it still ALLOWs, and the primary path for both arms stays BLOCK.

## Cases

6 pilot cases and their labels are frozen at `832cedf` (sha256 of the canonical pilot JSON is checked in `comparison.test.ts`). 6 development cases are disjoint. `dev-05` is a mandatory second approval that is still pending. `dev-06` is the same payment without that obligation. Quote-quality fixtures on `dev-05` (missing, inaccurate, irrelevant, correct, and open with a null quote) must not ALLOW.

## Report rows

Each smoke or pilot row has `caseId`, `arm`, `providerStatus`, `parserResult` (`ok` or the frozen `parseOutput` rejection), `frozenGateVerdict`, `publicVerdict`, and `firstAllowBlocker`. The blocker is the first step that is not on the path to ALLOW: provider, then `parser:<rejection>`, then `frozen_gate:<verdict>`, then `grounding_follow_up` when the frozen gate said ALLOW and the follow-up did not. A parser rejection is `validator_rejection`, not substantive UNCERTAIN, even though the frozen gate still publishes UNCERTAIN. If both dev-06 arms are public UNCERTAIN, `dev06.firstAllowBlocker` names that step for each arm.

One invalid claim on an otherwise valid payload is `schema_violation` from `parseOutput` (`adapter.ts`, the claims row that fails `take` makes the group contain null, and the parser returns `schema_violation`). The export does not change that decision.

## Commands

No provider call is made by the default CLI.

```sh
node --experimental-strip-types experiments/trade-contract/comparison-offline.ts
node --experimental-strip-types experiments/trade-contract/comparison-offline.ts --plan
node --experimental-strip-types experiments/trade-contract/comparison-offline.ts --schema-smoke
```

`--schema-smoke` without `--paid` prints the dev plan and does not send. The paid smoke command is prepared and refuses before any request:

```sh
node --experimental-strip-types experiments/trade-contract/comparison-offline.ts --schema-smoke --paid
```

Its constraints are 12 calls, 45 seconds per call, no retries, and a 1 USD total. Actual cost, when a response exists, is `usage.cost_in_usd_ticks / 10000000000`. The conversion is from https://docs.x.ai/developers/cost-tracking : 1 USD = 10^10 ticks. Missing ticks stay unknown. They are not treated as zero.

1 USD is not guaranteed before send. `max_completion_tokens` does not bound grok-4.7 reasoning tokens. https://docs.x.ai/developers/model-capabilities/text/best-practices and the chat-completions reference say the cap applies only to visible output. `reasoning_effort` `low` still reasons, and reasoning cannot be turned off. There is no published reasoning-token ceiling, so lowering `max_completion_tokens` does not make 12 times a worst case fit inside 1 USD. The command exits before any request.

The unpaid pilot command remains `--paid` without `--schema-smoke`. It is not run here. Set `GROUNDED_CRITIC_ALLOW_PAID` to the digit 1, `GROUNDED_CRITIC_COST_CAP_USD`, optional `GROUNDED_CRITIC_BUDGET_MS` (default 45000), and `XAI_API_KEY`. Its pre-send reservation is the same visible-token estimate and is also not an upper bound on reasoning.

## What a B win would mean

A B win on the later paid pilot would mean: on these 6 frozen pilot cases, with the same host, model, tools (none), and evidence, the extra instruction produced more justified public ALLOWs than arm A, and the false-ALLOW counts say whether unjustified cases were released. It would not mean the production critic was beaten, that #140's 0/36 result was fixed, that a bad quote can be dropped into ALLOW, or that the result generalizes past this extractor and this pilot.
