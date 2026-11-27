# Closed measured run: dev-v2 trade orders at 886d8cb8

Twelve provider calls, all ok. Measured cost 0.37902 USD from `cost_in_usd_ticks`. No call booked an estimate.

10 of 12 rows are label hits, and not more. ord-01, ord-02, ord-03, ord-04, and ord-06 match the sealed public verdict on both arms. ord-05 A and ord-05 B are UNCERTAIN. The sealed label is ALLOW. Both arms set `additional_claims` to `not_verifiable` because they emitted a claim whose text is `the 40 Helio shares`, kind `unsubstantiated_new_fact`, with empty `supportingQuotes`.

ord-03 has no `book` document and raised no such claim. ord-05 has the `book` document and raised the claim. Why the model did that on ord-05 and not on ord-03 is unresolved. This note does not treat the `book` document as the cause.
