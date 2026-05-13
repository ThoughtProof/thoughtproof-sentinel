/**
 * Memory Write Mode Handler
 *
 * Verifies: "Summary faithfully represents source before memory commit."
 *
 * Use case: Self-summary faithfulness. Before an agent writes to its
 * long-term memory, Sentinel checks that the summary (claim) accurately
 * represents the source material (evidence) without hallucination.
 */

import type { ModeHandler, ModeOutput } from './types.js';

export const memoryWrite: ModeHandler = (input): ModeOutput => {
  return {
    evalInput: {
      id: input.id,
      question: `Verify that the following memory summary faithfully represents the source material without hallucination, omission of critical facts, or distortion.`,
      answer: input.claim,
      trace_steps: input.evidence,
      gold_plan_steps: [
        {
          index: 0,
          description: 'Summary faithfully represents source material',
          criticality: 'critical',
          acceptance_criterion: 'Every factual claim in the summary is directly supported by the source evidence. No fabricated details, no critical omissions.',
        },
      ],
    },
    evalMode: 'faithfulness',
  };
};
