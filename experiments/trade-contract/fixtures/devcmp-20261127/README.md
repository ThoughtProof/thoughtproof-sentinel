# Closed diagnosis: paid payment comparison at a585f5eb

These twelve answers stay as recorded. They are the paid run of the payment dev cases, not a new case set.

The expected ALLOW payments were outside #140 scope: no strategy document, and `order_strategy_consistency` stays mandatory.

First `not_verifiable` check on each row (one row is one case and one arm). This is the first such check in check order. It is not the contradicted check that makes dev-02 and dev-05 BLOCK.

Public verdicts are 4 BLOCK (dev-02 A/B and dev-05 A/B) and 8 UNCERTAIN. No public ALLOW.

Of the eleven rows whose first `not_verifiable` check has model status `not_verifiable` at `evaluate.ts:277`, eight are `order_strategy_consistency` and three are `decision_basis` (dev-04 A, dev-04 B, dev-06 A). That is 8 and 3, not 9 and 2. dev-02 and dev-05 sit in the eight because this first check is the strategy check. Their public BLOCK is a later contradicted mandate, not this first check. dev-06 A is one of the three `decision_basis` rows.

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

The twelfth row is dev-01 B: first check `order_strategy_consistency`, model status `not_applicable` at `evaluate.ts:277`. That is the one counted occurrence of that pattern. The eleven `not_verifiable` rows are not that pattern, and they are not a `decision_basis` requirement-id mismatch or a mandate `INVALID_SEMANTIC_EVIDENCE`.
