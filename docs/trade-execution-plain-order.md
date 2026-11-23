# Plain orders in trade_execution

A plain market order is exactly `BUY|SELL market order: <amount> USDC|base of <product> on Coinbase`.

The criteria in `src/engine/modes/trade_execution.ts` are the prompt. They tell the model:

- step 0 passes when the decision cites no numerical threshold. A cited threshold fails only when the evidence number misses it. No number to check is weakly faithful, not a failure.
- step 1 fails when BUY meets a bearish thesis or SELL meets a bullish thesis. A missing price series is not that failure.
- step 2 passes when the decision states no justification beyond the order. A justification that cites a fact absent from the evidence fails.

`resolveTradeExecutionPlainOrder` applies the same reading to steps that were already recorded, without a new model call:

- BLOCK for a proven contradiction: direction, a fabricated justification, a threshold the evidence misses, or a Mandate section that differs from Principal instruction.
- UNCERTAIN when a cited threshold cannot be checked, or when a matching plain order still has an unfaithful direction step.
- ALLOW only for a plain order whose thesis matches the side and whose text contains none of those contradictions.

The recorded prod answers cannot show the prompt change. They still fail step 0 and step 2 for absence. The rescore shows only the deterministic reading. Confirming that serv-nano follows the new wording needs a new paid run.
