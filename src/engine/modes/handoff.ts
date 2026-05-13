/**
 * Handoff Mode Handler
 *
 * Verifies: "Agent output is coherent with the handoff packet."
 *
 * Use case: Inter-agent claim-packet coherence. When Agent A hands off
 * context to Agent B, Sentinel checks that the claim (what A says it's
 * handing off) matches the evidence (the actual handoff payload).
 */

import type { ModeHandler, ModeOutput } from './types.js';

export const handoff: ModeHandler = (input): ModeOutput => {
  return {
    evalInput: {
      id: input.id,
      question: `Verify the following inter-agent handoff claim is faithfully supported by the evidence provided.`,
      answer: input.claim,
      trace_steps: input.evidence,
      gold_plan_steps: [
        {
          index: 0,
          description: 'Handoff claim is coherent with evidence payload',
          criticality: 'critical',
          acceptance_criterion: 'The claim accurately represents the content and intent of the evidence without fabrication or omission of critical details.',
        },
      ],
    },
    evalMode: 'faithfulness',
  };
};
