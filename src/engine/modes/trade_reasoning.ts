/**
 * Trade Reasoning Mode Handler (ADR-0018)
 *
 * Fork of trade_execution. Same intent — verify a trade decision before
 * capital commits — but step_2 checks INFERENTIAL INTEGRITY (does the thesis
 * contradict its own reasoning?) instead of EVIDENCE GROUNDING (is every claim
 * literally present in the evidence?).
 *
 * Why the fork (see ADR-0018):
 *   A trading thesis is an argument, not a trace. The verifier has no
 *   independent ground truth — the "evidence" is the agent's own thesis +
 *   reasoning. Demanding evidence grounding makes the verifier confirm a claim
 *   against a document that only contains that claim → always "weakly
 *   supported" → CONDITIONAL_ALLOW → UNCERTAIN → trade dies. That drove ~82% of
 *   UNCERTAINs in the CB4A benchmark.
 *
 *   The deterministic structural layer (cb4a-verify) now owns factuality:
 *   direction contradictions hard-BLOCK before we ever call Sentinel, and soft
 *   numeric deviations arrive as VERIFIED FACTS in the evidence. So Sentinel's
 *   job here is purely coherence: given the (verified) facts, does the
 *   reasoning hold together?
 *
 * Three critical gold steps — all must pass for ALLOW:
 *   1. Numerical thresholds actually met        (unchanged from trade_execution)
 *   2. Directional claims match the evidence     (unchanged)
 *   3. Inferential integrity (NO self-contradiction / non-sequitur)   (NEW)
 */

import type { ModeHandler, ModeOutput } from './types.js';

export const tradeReasoning: ModeHandler = (input): ModeOutput => {
  return {
    evalInput: {
      id: input.id,
      question: `Verify that this trade decision is internally coherent: any numerical thresholds it invokes are met, its directional claims are consistent with the evidence, and its justification follows from its own stated reasoning without self-contradiction or unsupported leaps.`,
      answer: input.claim,
      trace_steps: input.evidence,
      gold_plan_steps: [
        {
          index: 0,
          description: 'Claimed thresholds are actually met by the numbers in evidence',
          criticality: 'critical',
          acceptance_criterion:
            'Every numerical threshold cited in the decision (e.g. "requires 70%") must be met by the actual number in the evidence. If the evidence shows the value is below the threshold, this step FAILS. Note: verified facts prefixed "structural_fact:" are authoritative ground truth — measure thresholds against those when present.',
        },
        {
          index: 1,
          description: 'Directional claims match the evidence',
          criticality: 'critical',
          acceptance_criterion:
            'If the decision claims an uptrend, the evidence (including any "structural_fact:" lines) must be consistent with an uptrend. If the evidence shows the opposite direction, this step FAILS.',
        },
        {
          index: 2,
          description: 'Inferential integrity — the thesis does not contradict its own reasoning',
          criticality: 'critical',
          acceptance_criterion:
            'First classify each claim in the thesis as: factual (observable market data), derived (calculated from the stated reasoning), interpretive (a pattern judgment), or predictive (forward-looking). ' +
            'This step FAILS only on a genuine inferential defect: ' +
            '(1) a claim that CONTRADICTS the reasoning (e.g. thesis says "bullish momentum" but the reasoning describes a downtrend); ' +
            '(2) a conclusion that invokes a factor NEVER MENTIONED in the reasoning (e.g. thesis cites a funding rate the reasoning never discusses); ' +
            '(3) a logical non-sequitur where the stated analysis does not support the proposed action. ' +
            'The following are NOT failures and MUST pass: numerical rounding or timeframe differences (the agent is the data processor); derived metrics not quoted verbatim in the evidence (e.g. "76% of range"); interpretive judgments consistent with the reasoning (e.g. "suggests a breakout"); predictive claims clearly framed as forward-looking. ' +
            'When a "structural_fact:" line reports a verified value that deviates from a thesis claim, judge whether the thesis CONCLUSION still holds given the verified value — a small deviation that does not change the conclusion is NOT a failure.',
        },
      ],
    },
    evalMode: 'faithfulness',
  };
};
