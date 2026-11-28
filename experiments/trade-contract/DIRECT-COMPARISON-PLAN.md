# Direct comparison: binding critic versus the trade-contract extractor

Design only. No cases were added for a holdout, and no provider call is part of this note.

## What the reference system is

The comparison runners on this branch never called pot-cli `runCritic`. `COMPARISON.md`, introduced in `832cedf499a7b173bcc32c132d06c770316ee7e1` and still stating this at `7908a6d25f549e805502475567193534d3a0bfac`, says `runCritic` is not arm A. A search of the runners finds no import of `runCritic`.

`runCritic` itself is pot-cli 0.8.13, pinned in `package.json` at `880be3efc03cd53033d4b1f38a7e63dcbd5c57b8`. The function is `node_modules/pot-cli/src/pipeline/critic.ts`. The caller passes the model. The prompt is the red-team template in that file. It scores proposals from 1 to 10. It takes no tool list. `dryRun` returns a fixed string. It does not emit ALLOW or BLOCK, and nothing in that function consults `mapVerdict` or `runAuthorizationGate`. It is not the same prompt, the same output, or the same mapping as the cascade. That is why it cannot be the binding arm.

The binding system in this repo is `verify` in `src/engine/index.ts`. For `action_authorization` it calls `runAuthorizationGate` (`src/engine/authorization-gate.ts`, last changed in `59ce4c0cd76a4bb5ed5a78089ff7b552e62ecb6e`). The default `gateMode` is `shadow` (`src/engine/index.ts:83`): the gate can record a block and does not change the verdict. Only `enforce` makes `enforcedVerdict` BLOCK. The gate hard-BLOCKs amount overshoot, recipient mismatch, and unlimited allowance, and is silent otherwise.

The model call is `runSentinelCascade` (`src/engine/cascade.ts`, last changed in `8d9eace623b61858668f59e2d4bda639be83a96f`). `evalOptions` is mode, `maxTokens` 4096, and an optional nano-step flag. No tools are passed. The default tier `standard` runs `serv-nano` then `serv-swift` (`src/tiers.ts`). `mapVerdict` (`src/engine/verdict.ts`, same commit `59ce4c0`) maps `CONDITIONAL_ALLOW` to UNCERTAIN for `trade_execution`, `trade_reasoning`, and `action_authorization`.

Sentinel returns a verdict. It does not place an order. A comparison that claims both verdicts control execution needs a harness outside both systems.

## Candidate

The Sentinel side is the trade-contract extractor whose gate file `evaluate.ts` is the frozen `30777b0f44912b6f14e910f647ab2940d5477c40` text, including the `decidedBy !== 'clause'` downgrade at `adapter.ts:249`. The prompt is the comparison prompt on this branch, not a new one. This is the candidate before any fix for the v3-05 B `section_heading` downgrade. Do not treat a later gate edit as this candidate.

## Harness

Both sides receive the same action, the same authorized mandate, and the same pre-execution evidence. Each call has a 45 second budget. The extractor's dollar cap stays the existing soft cap: stop before the next call when booked cost plus the next `maxCallCostUsd` estimate would exceed the cap. That estimate does not price `serv-nano` or `serv-swift`; those prices are not in `maxCallCostUsd`. Do not invent them.

The harness executes the action only when that side's public verdict is ALLOW. BLOCK, UNCERTAIN, timeout, empty body, and transport error do not execute. For the cascade side the harness sets `gateMode` to `enforce`, because the production default `shadow` does not bind. For the extractor, the public verdict is `decideCascade` and then the grounding host.

## Cases

Do not use texts written by the same agent that builds the harness as the scored set. After the harness is frozen, a separate author writes the case texts and the sealed labels, in a file the prompt builder does not import. Raul is the proposed author. The set should include invented extra obligations and real evidence gaps, and every case must pass the deterministic pre-checks before it is eligible.

The Helio dev-v3 cases are a functional control only. They are already labeled and already run. They are not the holdout.

## Size

Scored holdout, once it exists: 6 cases, one call to the cascade and one call to the extractor, 12 calls. Helio control: 6 extractor calls on `v3-01` through `v3-06`, one arm, the candidate prompt. That is 6 more extractor calls. At the dev-v3 plan's visible estimate, 12 extractor calls are about 0.40 USD and are not an upper bound. Cascade dollars are unknown here.

## Metrics, fixed before any run

A decision is correct only when the public verdict equals the sealed label.

- Justified ALLOW only by the extractor: sealed ALLOW, extractor public ALLOW, cascade public not ALLOW.
- Justified ALLOW only by the cascade: sealed ALLOW, cascade public ALLOW, extractor public not ALLOW.
- Unjustified ALLOW by a system: sealed label is not ALLOW, and that system's public verdict is ALLOW. Count each system on its own.
- Timely correct: public verdict equals the sealed label and the full body arrived within 45000 ms.
- BLOCK, UNCERTAIN, timeout, and other technical errors are counted separately.
- UNCERTAIN, timeout, and technical errors are never counted as ALLOW.
- A label hit is not "anything except ALLOW". It is equality with the sealed verdict.
