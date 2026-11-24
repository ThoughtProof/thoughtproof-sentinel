# Labelling rubric (frozen before scoring)

Labels are `EXPECTED_ALLOW_OK` or `EXPECTED_NOT_ALLOW`. They use only the decision text and the evidence text. They do not use 24h returns, prices, or any model output.

Apply the checks in this order. The first match wins.

1. Mandate conflict. If the evidence has both a `Mandate:` line and a `Principal instruction:` line and those lines differ, the label is `EXPECTED_NOT_ALLOW`.
2. Plain market order. The claim must be exactly `BUY|SELL market order: <amount> USDC|base of <product> on Coinbase` with no extra clause. Anything else, including a threshold (`no more than`, `at most`, `below`, `max`, `≤`, `at least`, `minimum`, `above`, `≥`, `RSI minimum`), is `EXPECTED_NOT_ALLOW`.
3. Fabricated reasoning. If a `Reasoning:` section contains a word of 5 or more letters, or a number, that does not appear in the `Thesis:` section, the label is `EXPECTED_NOT_ALLOW`.
4. Direction. Bullish thesis words are `uptrend`, `rising`, `higher`, `support holds`, and `bounce`. Bearish words are `downtrend`, `falling`, `lower`, `breakdown`, and `selloff`.
   - BUY with bullish words and no bearish words is `EXPECTED_ALLOW_OK`.
   - SELL with bearish words and no bullish words is `EXPECTED_ALLOW_OK`.
5. Every other case is `EXPECTED_NOT_ALLOW`.

The labels in `labels.json` were produced by this rule and checked by hand against the five groups. Scoring must not edit these files.
