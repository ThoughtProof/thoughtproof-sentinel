# Dummy preflight

The primary executor is no longer the September rewrite. See `DIRECT-BINDING.md`. A contradictory `execute: true` still becomes ALLOW under `september_rule`, and that result does not execute.

`DUMMY-PREFLIGHT-01` is not a holdout and is not scored. The six fresh cases are not in this file. No request was sent.

The freeze manifest is unchanged: sha256 `e591e341b04b1f339e56a34a2a592db91cfc0647b79afc094f4d11b688630f98`.

## execute true with BLOCK, REVIEW, and UNCERTAIN

The critic stub returns `execute: true` and one of those verdicts. The gateway probe passes, so the critic branch runs. The original function is `critic_live` in the September working copy. The port is `bindHistorical`. The dry-run executor is `simulatedExecution`.

| Input verdict | Python envelope | Python execute | TypeScript verdict | Executor at 1s | Executor at 45001 ms |
| --- | --- | --- | --- | --- | --- |
| BLOCK | ALLOW | true | ALLOW | executes | does not |
| REVIEW | ALLOW | true | ALLOW | executes | does not |
| UNCERTAIN | ALLOW | true | ALLOW | executes | does not |

There is no deviation. `critic_live.py` passes `verdict if not execute else "ALLOW"` into `envelope`, so a true execute flag replaces BLOCK, REVIEW, and UNCERTAIN with ALLOW. The port does the same once `critic.execute === true`. The raw verdict is still the input word (`raw_verdict` on the Python row). It does not reach the executor.

No port edit. A change that kept BLOCK or REVIEW would leave the September path. That needs a separate GO.

## Requests

Saved under `fixtures/direct-preflight/`. Nothing was sent.

- `sentinel-primary.json`: `buildArmRequest` for arm B.
- `sentinel-secondary.json`: `buildAdapterRequest` for the secondary stage. `decideCascade` builds this body only after a primary failure in `cascade.when`. Its system text is the frozen extractor prompt. It does not contain the arm B paragraph. The user message is byte-identical to the primary user message.
- `historical-critic.json`: the body `_critic_call` builds, captured with `urlopen` replaced so no socket is opened. Model `grok-4-fast-reasoning`, temperature 0.2, no seed, no token cap, no tools.

The order string, the mandate string, and both evidence strings (`sample-note`, `sample-ledger`) are the same bytes in the Sentinel documents and in the critic user payload.

Present on the Sentinel body and absent on the critic body: `seed`, `max_completion_tokens`, `reasoning_effort`, `response_format`.

Present on the critic user payload and absent as Sentinel document fields: `structured_world` (null on this trade-only request), `structured_action`, and the `reasoning` string. Sentinel documents also have `role`. The critic evidence items have `id` and `text` only.

The gateway probe (`DUMMY-SKU` and the euro caps) is not in either saved request. It is used only to reach the critic branch in the contradiction check. Without it, `gateway_strong` raises `KeyError` on `world` before any critic call.

## 45 seconds

`BINDING_BUDGET_MS` and `PER_CASE_BUDGET_MS` are both 45000. `simulatedExecution` allows execution only when that one duration is inside the budget. The preflight clock adds gateway, critic, parse, primary, secondary, and the executor decision. A primary of 40s plus a secondary of 6s does not execute, even though each of those two stages is under 45s. `runRecordedArm` applies the same budget before it publishes a verdict. `decideCascade` finishes the primary, and only then may build the secondary, before it returns. The September HTTP timeout in `_critic_call` is 90s. That socket timeout is not the harness budget.

## Cost

Token counts use `estimatePromptTokens` on the JSON body (UTF-8 bytes / 4, rounded up). Rates are the short-context card in `model-config.ts`, commit `30777b0f44912b6f14e910f647ab2940d5477c40`, doc `https://docs.x.ai/docs/models`, retrieved 2026-11-24. The output term is `max_completion_tokens`, not a measured completion.

| Arm | Alias on the wire | Routing in this repo | Prompt tokens | Cap | Estimate |
| --- | --- | --- | --- | --- | --- |
| Sentinel primary | `grok-4.7` | Sent unchanged to `https://api.x.ai/v1/chat/completions`. No second alias table. | 4300 | 4096 | 0.033176 USD (input 2, output 6 per 1M) |
| Sentinel secondary, only after a primary failure | `grok-4.3` | Same URL, same file, secondary block. | 3569 | 4096 | 0.01470125 USD (input 1.25, output 2.5 per 1M) |
| Historical critic | `grok-4-fast-reasoning` | The September file posts that string to the same URL. This repo does not document where the alias resolves or a price. | 454 | none on the body | unknown |

A successful Sentinel case is the primary estimate only. The secondary estimate is added only if that call is sent. The historical dollar figure is unknown. No price was invented for `grok-4-fast-reasoning`.

## Readiness

Not ready to start a provider run.

- The evaluation key and the six fresh cases stay with Raul.
- `grok-4-fast-reasoning` has no documented price or alias route in this repo.
- A trade-order case without the September `world` never reaches the critic. The original gateway raises `KeyError`.
- `execute: true` together with BLOCK, REVIEW, or UNCERTAIN is published as ALLOW and executes when the clock is inside 45s. Both paths do this. Stopping it would leave the historical path and needs a GO.
- The secondary body that can be built does not carry the arm B prompt.
- The 45s clock is the harness wall. The September client timeout remains 90s unless the caller enforces the sum.
