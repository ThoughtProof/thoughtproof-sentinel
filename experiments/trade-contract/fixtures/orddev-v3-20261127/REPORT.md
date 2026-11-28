# dev-v3 paid run at ce3474ed

Source tarball sha256 `e7cd8bfcb77091d6a6fb6ab82a81aeaf43fe5ef796c8bfc4d8f07b4ebef0b9c5`. The committed `report.json` and `raw/*.json` hashes are in `SHA256SUMS`. The run used `runTradeOrderDev` with `timeoutMs` 90000 and `softCapUsd` 1. Twelve calls, no retries, measured cost 0.373026 USD, none booked from an estimate.

One row is one case and one arm. A label hit is a public verdict equal to the sealed expected verdict. 11 of 12 are hits, and not more. Arm A is 6/6. Arm B is 5/6. The v2 column is the public verdict of the same logical case in `fixtures/orddev-20261127`.

| Row | Expected | Frozen | Public | Decisive check in the report | ms | v2 public |
| --- | --- | --- | --- | --- | --- | --- |
| v3-01 A | ALLOW | ALLOW | ALLOW | none (ALLOW) | 39694 | ALLOW |
| v3-01 B | ALLOW | ALLOW | ALLOW | none (ALLOW) | 39104 | ALLOW |
| v3-02 A | BLOCK | BLOCK | BLOCK | mandate_compliance contradicted | 47426 | BLOCK |
| v3-02 B | BLOCK | BLOCK | BLOCK | mandate_compliance contradicted | 43294 | BLOCK |
| v3-03 A | ALLOW | ALLOW | ALLOW | none (ALLOW) | 45301 | ALLOW |
| v3-03 B | ALLOW | ALLOW | ALLOW | none (ALLOW) | 47366 | ALLOW |
| v3-04 A | UNCERTAIN | UNCERTAIN | UNCERTAIN | order_strategy_consistency not_verifiable | 39435 | UNCERTAIN |
| v3-04 B | UNCERTAIN | UNCERTAIN | UNCERTAIN | order_strategy_consistency not_verifiable | 32948 | UNCERTAIN |
| v3-05 A | ALLOW | ALLOW | ALLOW | none (ALLOW) | 40636 | UNCERTAIN |
| v3-05 B | ALLOW | UNCERTAIN | UNCERTAIN | decision_basis not_verifiable | 38499 | UNCERTAIN |
| v3-06 A | BLOCK | BLOCK | BLOCK | order_strategy_consistency contradicted | 51042 | BLOCK |
| v3-06 B | BLOCK | BLOCK | BLOCK | order_strategy_consistency contradicted | 40717 | BLOCK |

The only public change from v2 is v3-05 A, which moved from UNCERTAIN to ALLOW. The only public difference between A and B in this run is v3-05. Arm A is at the ceiling on this set: 6/6.

## v3-05 B

The stored JSON parses (`parseOutput` ok). All three semantic checks are `fulfilled`. The holdings claim is `source_fact` / `fulfilled`, supported by `40 Helio shares` on document `holdings`. `grounding` is null, so the grounding host is not what changed this row.

`requirements[0]` is the strategy. `decidedBy` is `section_heading`, `sourceHeading` is `Strategy`, and the requirement quote is `Reduce Helio exposure.` The only strategy line in the case is `Strategy: Reduce Helio exposure.`

`adapter.ts:249` sets `downgradeAllow` when any requirement has `decidedBy !== 'clause'`. `downgrade` (`adapter.ts:290-300`) runs only when the evaluation decision is ALLOW. It publishes UNCERTAIN and rewrites every non-contradicted check to `not_verifiable`. The stored cascade result is that rewrite: five `not_verifiable` checks and an empty diagnostic list. `decisiveReason` `decision_basis not_verifiable` is only the first of those five. It is not a separate evidence failure.

Changing only `requirements[0].decidedBy` from `section_heading` to `clause` and running the same cascade publishes ALLOW: `decision_basis`, `order_strategy_consistency`, `mandate_compliance`, and `additional_claims` are `fulfilled`, and `numeric_limits` is `not_applicable`. That is the evaluation before the downgrade. It is accurate to call that intermediate result a parser-valid ALLOW. It is not accurate to call the published cascade verdict ALLOW. The test is `orddev-v3-archive.test.ts`, `shows v3-05 B is ALLOW before the section_heading downgrade and UNCERTAIN after it`.

Across both archives there are 20 strategy requirements. 19 use `decidedBy` `clause`. This row is the only `section_heading`. 24 mandate requirements use `clause`. The figure 23 does not match these files.

## Holdings

Every one of the 12 stored answers has exactly one claim. It is `source_fact`, status `fulfilled`, and its supporting quote is on `holdings`. No public ALLOW in this run came from leaving that check out.

## 90 seconds and 45 seconds

Label quality at the 90 second timeout is 11/12. That is separate from decisions that were both correct and fully received within 45 seconds.

Within 45 seconds: v3-01 A, v3-01 B, v3-02 B, v3-04 A, v3-04 B, v3-05 A, v3-05 B, v3-06 B (8/12). Correct within 45 seconds: 7/12. v3-05 B is inside 45 seconds and wrong.

Over 45 seconds, all four still correct: v3-02 A 47426 ms, v3-03 A 45301 ms, v3-03 B 47366 ms, v3-06 A 51042 ms.
