/**
 * Trade Execution Mode Handler
 *
 * Verifies: "The trade execution decision is internally consistent."
 *
 * Use case: Autonomous trading agents (e.g. Cobot). Before an agent
 * commits capital, Sentinel checks that thresholds are met, directional
 * claims match evidence, and no justifications are fabricated.
 *
 * Three critical gold steps:
 * 1. A cited numerical threshold is met. Citing none is not a failure.
 * 2. Directional claims match the evidence. A proven opposite is a failure.
 * 3. Stated justifications are not fabricated. Stating none is not a failure.
 */

import type { ModeHandler, ModeOutput } from './types.js';
import { tradeMandateBodies } from '../trade-execution-plain-order.js';

/**
 * The evaluator tells every trade_execution step to judge TRACE EXCERPT and
 * to quote only that section. The order is the claim; the thesis is the
 * evidence. Both have to be inside that section or the model cannot see the
 * side, size, or venue it is asked to judge. When the evidence has a Mandate
 * or Principal instruction section, those bodies are repeated in a MANDATE
 * block so the limit check is not only buried in the evidence prose.
 */
export function tradeExecutionTrace(claim: string, evidence: string): string {
  const bodies = tradeMandateBodies(evidence);
  const parts = [`ORDER:\n${claim}`];
  if (bodies) {
    parts.push(
      `MANDATE:\nmandate body: ${bodies.mandate}\nprincipal instruction body: ${bodies.instruction}`,
    );
  }
  parts.push(`EVIDENCE:\n${evidence}`);
  return parts.join('\n\n');
}

export const tradeExecution: ModeHandler = (input): ModeOutput => {
  return {
    evalInput: {
      id: input.id,
      question: `Verify this trade execution using only the TRACE EXCERPT. It contains an ORDER block, an EVIDENCE block, and a MANDATE block when the evidence has one. A plain market order with no numerical limit, no MANDATE block, a Thesis direction that matches the side, and no Reasoning section passes. FAIL only the specific mismatches named in the steps: a limit the evidence number misses, a Mandate body that differs from the Principal instruction body, an ORDER side opposite the Thesis word, or a Reasoning token absent from the Thesis. A cited limit with no comparable number is weakly_faithful, not a pass and not a fail.`,
      answer: input.claim,
      trace_steps: tradeExecutionTrace(input.claim, input.evidence),
      gold_plan_steps: [
        {
          index: 0,
          description: 'Cited limits: a numerical bound, and mandate agreement',
          criticality: 'critical',
          acceptance_criterion:
            'Use only the TRACE EXCERPT. A trade size such as "75 USDC" or "1.4 base", and a product name, are not limits. '
            + 'Threshold: PASS if the ORDER cites none of these limit forms: "RSI minimum 70%", "no more than", "at most", "at least", "minimum", "below", "above", "max", ">=" or "<=". '
            + 'FAIL if the ORDER cites one and the EVIDENCE block contains a number that misses it: a minimum, "at least", "above", or ">=" missed by a smaller number, or a maximum, "no more than", "at most", "below", or "<=" missed by a larger number. '
            + 'If the ORDER cites one and the EVIDENCE block has no comparable number, set predicate weakly_faithful and score 0.5. Do not PASS that case and do not FAIL it. '
            + 'Mandate: if a MANDATE block is present and its mandate body text differs from its principal instruction body text, FAIL. '
            + 'If the MANDATE block is absent, or the two bodies are the same text, that is not a failure. '
            + 'A plain order with no limit form and no MANDATE block PASSES this step. Absence of a limit is not a failure.',
        },
        {
          index: 1,
          description: 'Order side matches the thesis direction',
          criticality: 'critical',
          acceptance_criterion:
            'Use only the TRACE EXCERPT. Compare the ORDER side, BUY or SELL, to the Thesis line in the EVIDENCE block. '
            + 'Bullish Thesis words, and only these: uptrend, rising, higher, support holds, bounce. '
            + 'Bearish Thesis words, and only these: downtrend, falling, lower, breakdown, selloff. '
            + 'FAIL with predicate unfaithful and score 0 when the side is BUY and the Thesis has a bearish word and no bullish word. '
            + 'FAIL with predicate unfaithful and score 0 when the side is SELL and the Thesis has a bullish word and no bearish word. '
            + 'PASS with predicate faithful and score at least 0.75 when the side is BUY and the Thesis has a bullish word and no bearish word. '
            + 'PASS with predicate faithful and score at least 0.75 when the side is SELL and the Thesis has a bearish word and no bullish word. '
            + 'If the Thesis has neither list, or has both, set weakly_faithful and score 0.5. A missing price series is not a FAIL when the Thesis word and the side match.',
        },
        {
          index: 2,
          description: 'Stated justifications are not fabricated',
          criticality: 'critical',
          acceptance_criterion:
            'Use only the TRACE EXCERPT. PASS if the EVIDENCE block has no Reasoning section. A Thesis alone is not a fabricated justification. Absence of a justification is not a failure. '
            + 'If a Reasoning section is present, compare it only to the Thesis section in the same EVIDENCE block. '
            + 'FAIL with predicate unfaithful and score 0 when Reasoning contains a number, including one with a percent sign, or a word of 5 or more letters, that does not appear in the Thesis. Examples that FAIL: "funding is 0.12%", "liquidation is 4.5%". '
            + 'PASS when every such number and word in Reasoning also appears in the Thesis. Do not FAIL a Thesis that only repeats direction words.',
        },
      ],
    },
    evalMode: 'faithfulness',
  };
};
