# Strict binding

The primary arm is **historischer Critic + Gateway mit strikter Bindung**. The freeze file is `direct-binding-manifest.json`. Its sha256 is `e01e59a4601e783f37152e791fe7788a7e4afb9682543c88a3b0355b5bf49909`. The Sentinel manifest `e591e341b04b1f339e56a34a2a592db91cfc0647b79afc094f4d11b688630f98` is unchanged.

Execution requires a passed gateway, a typed critic answer, `execute === true`, `verdict === "ALLOW"`, and at most 45000 ms. `execute: true` with BLOCK, REVIEW, or UNCERTAIN, and `execute: false` with ALLOW, are `protocol_error` and do not execute. `september_rule` still rewrites a true execute flag to ALLOW. That result is recorded and is not the executor.

On `DUMMY-PREFLIGHT-01` a timely typed ALLOW executes. The same ALLOW at 45001 ms does not. A gateway failure does not reach the critic and is not a protocol error.

## Holdout package

Zip sha256 `a9a80449969662c4c0753c397b76cf1f86a14d11261e20d851b9f425d6c38f09`. `cases.json` matches `casesSha256` `2b666f11c3033fdb1a1a00384fbbe8abfb55a5906f6e472d5b081660a3860467`. The package names `sealed-labels.json` and does not contain it. That file was not opened. The six cases are not committed. Request hashes are in `fixtures/direct-preflight/holdout-request-hashes.json`.

| caseId | Gateway | Critic | Documents | world/action unchanged | secondary_called | public_verdict_stage |
| --- | --- | --- | --- | --- | --- | --- |
| d17a63f4 | pass | reached | equal | yes | false | none |
| 2e6b384a | pass | reached | equal | yes | false | none |
| 94c5a620 | pass | reached | equal | yes | false | none |
| 8c036e51 | pass | reached | equal | yes | false | none |
| 365dfe89 | pass | reached | equal | yes | false | none |
| f4072db3 | pass | reached | equal | yes | false | none |

No model answer exists, so the secondary was not called and no stage has published a verdict. When a primary exchange fails for a reason in `cascade.when` and a secondary exchange is supplied, `sentinelStage` records `secondary` and the public verdict is BLOCK or UNCERTAIN.

## Cost

The historical wire alias stays `grok-4-fast-reasoning`. Raul GO t942u states that xAI routes that alias to `grok-4.3` with reasoning low, at 1.25 USD per million input tokens and 2.50 USD per million output tokens. That rate is not in `model-config.ts`. Prompt tokens are `estimatePromptTokens` on the built JSON. Two output assumptions are shown. Neither is a ceiling: the historical body has no output limit.

| Arm | Prompt tokens | Output assumption | USD |
| --- | --- | --- | --- |
| Sentinel primary, six `grok-4.7` calls | 28137 | 4096 cap on each body | 0.20373000 |
| Sentinel secondary, only if all six primaries fail | 23755 | 4096 cap on each body | 0.09113375 |
| Historical critic, six calls | 5747 | 256 | 0.01102375 |
| Historical critic, six calls | 5747 | 4096 | 0.06862375 |

Sentinel rates are the short-context card in `model-config.ts` at `30777b0`. A `grok-4.7` reasoning token is not bounded by `max_completion_tokens`, so the Sentinel figure is also not a measured bill. A run with no secondary is the primary total plus one historical column. Adding the secondary worst case and the 4096 historical column is 0.36348750 USD, and the historical part can still go higher.

## Shared budget

Both arms, including a Sentinel secondary call, share 1.00 USD in `direct-budget.ts`. Before each send the ledger checks measured cost plus open reservations plus the next estimate. Above 1.00 USD the call is `not_run_budget` and nothing is sent. After a response, confirmed usage replaces that call's reservation. A timeout or missing usage leaves the reservation open. When measured cost plus open reservations reaches 1.00 USD, sending stops. `measured_usd`, `open_reservations_usd`, and `actual_overrun_usd` stay separate. The overrun is confirmed spend above 1.00 USD, not a reservation. The next-call estimate assumes 32768 output tokens. That is not a ceiling. `createSpendLedger` is the same reserve, replace, and keep pattern, but its single booked figure cannot report the three amounts.

## Readiness

Not ready to start a provider call. The six requests reach the critic and the strict binding is frozen. The historical body still has no output limit, so no dollar cap derived from these requests is a ceiling. The sealed labels stay with Raul and were not read.
