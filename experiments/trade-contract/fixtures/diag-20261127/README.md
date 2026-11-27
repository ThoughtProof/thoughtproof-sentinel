# Closed diagnosis: payment dev cases (archive 7908a6d)

These raw answers and the payment cases `dev-01` through `dev-06` stay as they were. They are not the next comparison set.

The sealed ALLOW labels on dev-01, dev-03, and dev-06 were outside the #140 contract. Those bundles contain a payment and a mandate, and no strategy. `order_strategy_consistency` is mandatory (`evaluate.ts:246`). A model-generated empty requirement list does not turn that check off. The justified payment ALLOWs were therefore not a result this extractor could honestly reach.
