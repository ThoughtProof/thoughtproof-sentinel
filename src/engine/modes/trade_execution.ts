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

export const tradeExecution: ModeHandler = (input): ModeOutput => {
  return {
    evalInput: {
      id: input.id,
      question: `Verify this trade execution. A plain market order that states no threshold and no justification is not a failure for that absence. FAIL a step only for a proven contradiction: a cited threshold the evidence misses, an order side opposite the thesis, or a justification that cites a fact the evidence does not contain. If the evidence is not enough to check a claim, say so; do not treat the gap as a contradiction.`,
      answer: input.claim,
      trace_steps: input.evidence,
      gold_plan_steps: [
        {
          index: 0,
          description: 'A cited threshold is met; citing none is not a failure',
          criticality: 'critical',
          acceptance_criterion:
            'If the decision cites no numerical threshold, PASS this step. Absence is not a failure. If it cites one (for example "RSI minimum 70%" or "no more than 30%") and the evidence contains a number that misses it, FAIL. If it cites one and the evidence has no number that can confirm or contradict it, mark the step weakly_faithful. Do not FAIL only because the trace states no threshold.',
        },
        {
          index: 1,
          description: 'Order side matches the thesis direction',
          criticality: 'critical',
          acceptance_criterion:
            'FAIL when the order is BUY and the thesis is only bearish, or SELL and the thesis is only bullish. PASS when the thesis direction matches the order. If the thesis states no direction, mark the step weakly_faithful. Missing a price series is insufficient evidence, not a proven contradiction.',
        },
        {
          index: 2,
          description: 'Stated justifications are not fabricated',
          criticality: 'critical',
          acceptance_criterion:
            'If the decision states no justification beyond the order itself, PASS this step. Absence of a justification is not fabrication. FAIL only when a stated justification cites a fact that is not in the evidence, or contradicts the evidence.',
        },
      ],
    },
    evalMode: 'faithfulness',
  };
};
