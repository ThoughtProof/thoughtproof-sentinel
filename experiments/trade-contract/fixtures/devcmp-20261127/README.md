# Closed diagnosis: paid payment comparison at a585f5eb

These twelve answers stay as recorded. They are the paid run of the payment dev cases, not a new case set.

Public verdicts were BLOCK for dev-02 A/B and dev-05 A/B, and UNCERTAIN for the other eight. No public ALLOW. The expected ALLOW payments were outside #140 scope: no strategy document, and `order_strategy_consistency` stays mandatory.

First `not_verifiable` check on each row (one row is one case and one arm). This is the first such check in check order. It is not the contradicted check that makes dev-02 and dev-05 BLOCK.

Eleven rows have model status `not_verifiable` at `evaluate.ts:277`. That status is not one of the three counted archive patterns (`decision_basis` requirement-id mismatch, strategy status `not_applicable` at line 277, mandate `INVALID_SEMANTIC_EVIDENCE`).

| Row | First not_verifiable check | Model status at evaluate.ts:277 |
| --- | --- | --- |
| dev-01 A | order_strategy_consistency | not_verifiable |
| dev-01 B | order_strategy_consistency | not_applicable |
| dev-02 A | order_strategy_consistency | not_verifiable |
| dev-02 B | order_strategy_consistency | not_verifiable |
| dev-03 A | order_strategy_consistency | not_verifiable |
| dev-03 B | order_strategy_consistency | not_verifiable |
| dev-04 A | decision_basis | not_verifiable |
| dev-04 B | decision_basis | not_verifiable |
| dev-05 A | order_strategy_consistency | not_verifiable |
| dev-05 B | order_strategy_consistency | not_verifiable |
| dev-06 A | decision_basis | not_verifiable |
| dev-06 B | order_strategy_consistency | not_verifiable |

dev-01 B is the one row in the counted pattern "strategy status `not_applicable` at line 277" (1 occurrence, and it is that row's first error). The other eleven are the distinct model status `not_verifiable`.
