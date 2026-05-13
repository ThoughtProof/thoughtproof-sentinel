/**
 * Output Synthesis Mode Handler
 *
 * Verifies: "Final output is supported by the evidence chain."
 *
 * Use case: Final output quality verification. Before an agent delivers
 * its final response, Sentinel checks that the output (claim) is
 * grounded in the reasoning trace and evidence (evidence).
 */

import type { ModeHandler, ModeOutput } from './types.js';

export const outputSynthesis: ModeHandler = (input): ModeOutput => {
  return {
    evalInput: {
      id: input.id,
      question: `Verify that the following output is fully supported by the evidence chain. Check for unsupported claims, logical gaps, and hallucinated details.`,
      answer: input.claim,
      trace_steps: input.evidence,
      gold_plan_steps: [
        {
          index: 0,
          description: 'Output claims are grounded in evidence chain',
          criticality: 'critical',
          acceptance_criterion: 'Every substantive claim in the output traces back to specific evidence. No claims are fabricated or extrapolated beyond what the evidence supports.',
        },
        {
          index: 1,
          description: 'No logical gaps between evidence and conclusions',
          criticality: 'supporting',
          acceptance_criterion: 'The reasoning chain from evidence to output conclusion is logically valid without unstated assumptions.',
        },
      ],
    },
    evalMode: 'faithfulness',
  };
};
