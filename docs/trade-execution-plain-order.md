# Plain orders in trade_execution

A plain market order is exactly `BUY|SELL market order: <amount> USDC|base of <product> on Coinbase`.

Every trade_execution step is told to judge and quote only the TRACE EXCERPT. The order is therefore copied into that section, ahead of the evidence, as an ORDER block. It is not left only under AGENT ANSWER.

The criteria in `src/engine/modes/trade_execution.ts` are the prompt. They tell the model, by named words rather than a general warning:

- step 0 passes when the ORDER has no limit form and there is no MANDATE block. A trade size is not a limit. A cited limit fails only when an EVIDENCE number misses it, and is weakly faithful when no comparable number is present. A MANDATE block whose mandate body differs from the principal instruction body fails this step.
- step 1 fails only for a listed mismatch: BUY with a bearish Thesis word and no bullish word, or SELL with a bullish word and no bearish word. The matching pair passes even when no price series is present.
- step 2 passes when the EVIDENCE block has no Reasoning section. It fails when Reasoning contains a number or a word of 5 or more letters that the Thesis does not contain.

When the evidence has a Mandate or Principal instruction section, those bodies are copied into a MANDATE block from the same section reader the resolver uses. The resolver still reads the original evidence, not the prompt.

`resolveTradeExecutionPlainOrder` applies the same reading to steps that were already recorded, without a new model call:

- BLOCK for a proven contradiction: direction, a fabricated justification, a threshold the evidence misses, or a Mandate section that differs from Principal instruction.
- UNCERTAIN when a cited threshold cannot be checked, or when a matching plain order still has an unfaithful direction step.
- ALLOW only for a plain order whose thesis matches the side and whose text contains none of those contradictions.

The recorded prod answers cannot show the prompt change. They still fail step 0 and step 2 for absence. The rescore shows only the deterministic reading. Confirming that serv-nano follows the new wording needs a new paid run.
