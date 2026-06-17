/**
 * Sentinel Engine — Core Verification
 *
 * Pure function: SentinelVerifyRequest → SentinelVerifyResponse
 *
 * This is the engine. It has NO concept of:
 * - Auth (that's adapters/platform/)
 * - Payment (that's adapters/payment/)
 * - HTTP/Transport (that's api/sentinel/)
 *
 * It takes a verified, validated request and returns a verification result.
 */

import type {
  SentinelVerifyRequest,
  SentinelVerifyResponse,
  SentinelTier,
} from '../types.js';

import { getModeHandler } from './modes/index.js';
import { runSentinelCascade } from './cascade.js';
import { mapVerdict, canPromoteStep2Only } from './verdict.js';
import { randomUUID } from 'crypto';

/**
 * Run a single Sentinel verification.
 *
 * Pure computation: request in, response out.
 * No auth, no billing, no transport.
 */
export async function verify(req: SentinelVerifyRequest): Promise<SentinelVerifyResponse> {
  const startMs = Date.now();
  const id = req.id ?? `sent_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const tier: SentinelTier = req.tier ?? 'standard';

  // 1. Get mode handler and shape claim/evidence into EvalInput
  const modeHandler = getModeHandler(req.mode);
  const modeOutput = modeHandler({
    id,
    claim: req.claim,
    evidence: req.evidence,
    mode: req.mode,
  });

  // 2. Run through cascade (or solo for checkpoint)
  const cascadeOutput = await runSentinelCascade({
    evalInput: modeOutput.evalInput,
    evalMode: modeOutput.evalMode,
    tier,
  });

  // 3. Map verdict (mode-aware: trade_execution & trade_reasoning are conservative)
  let verdict = mapVerdict(cascadeOutput.result.verdict, req.mode);

  // 3b. trade_reasoning step_2-only promotion (ADR-0018). If the conservative
  //     remap produced UNCERTAIN but the two FACTUAL steps (thresholds,
  //     direction) both clear the SUPPORTED bar and only the inferential-
  //     integrity step (step_2) is weak, promote back to ALLOW: the facts
  //     checked out (and are backstopped by the deterministic structural
  //     layer), so a marginally-imperfect self-coherence step should not gate.
  const steps3b = cascadeOutput.result.step_evaluations;
  if (
    req.mode === 'trade_reasoning' &&
    verdict === 'UNCERTAIN' &&
    canPromoteStep2Only(
      steps3b.map((s) => ({ step_id: s.step_id, score: s.score, predicate: String(s.predicate) })),
    )
  ) {
    verdict = 'ALLOW';
  }

  // 4. Calculate confidence from step scores
  const steps = cascadeOutput.result.step_evaluations;
  const avgScore = steps.length > 0
    ? steps.reduce((sum, s) => sum + s.score, 0) / steps.length
    : 0;

  // 5. Surface per-step objections (the actionable substance). pot-cli
  //    already computes these; we slim them to client-relevant fields and
  //    attach the gold-step criterion (always deterministic). When the cheap
  //    SERV tiers omit per-step prose, synthesize a reasoning fallback so the
  //    objection is never opaque.
  const criterionByStepId = new Map<string, string>();
  for (const gs of modeOutput.evalInput.gold_plan_steps) {
    criterionByStepId.set(`step_${gs.index}`, gs.acceptance_criterion ?? gs.description);
  }

  const objections = steps.map((s) => {
    const criterion = criterionByStepId.get(s.step_id) ?? '';
    const prose = (s.reasoning ?? '').trim();
    return {
      step_id: s.step_id,
      criterion,
      score: Math.round(s.score * 1000) / 1000,
      predicate: String(s.predicate),
      quote: s.quote,
      reasoning: prose.length > 0
        ? prose
        : synthesizeReasoning(String(s.predicate), criterion, s.quote),
    };
  });

  const durationMs = Date.now() - startMs;

  return {
    id,
    verdict,
    confidence: Math.round(avgScore * 1000) / 1000,
    reasoning: cascadeOutput.result.verdict_reasoning,
    objections,
    mode: req.mode,
    tier,
    meta: {
      duration_ms: durationMs,
      models_used: cascadeOutput.modelsUsed,
      verified_at: new Date().toISOString(),
    },
  };
}

/**
 * Deterministic per-step reasoning fallback.
 *
 * The cheap SERV tiers (Nano) frequently omit the per-step `reasoning` prose
 * the evaluator prompt requests, leaving only predicate + score + quote. This
 * synthesizes a human-actionable sentence from the structured signal so a
 * consumer (agent or dashboard) is never handed an objection with no
 * explanation.
 */
function synthesizeReasoning(predicate: string, criterion: string, quote: string | null): string {
  const verdictPhrase: Record<string, string> = {
    unsupported: 'failed: the evidence does not support this criterion',
    unfaithful: 'failed: the decision is not faithful to the evidence for this criterion',
    partial: 'only partially met by the evidence',
    weakly_faithful: 'only weakly supported by the evidence',
    partially_faithful: 'only partially faithful to the evidence',
    supported: 'met by the evidence',
    faithful: 'faithful to the evidence',
    skipped: 'was not evaluated',
  };
  const phrase = verdictPhrase[predicate] ?? `evaluated as "${predicate}"`;
  const base = criterion
    ? `Criterion "${criterion}" was ${phrase}.`
    : `This step was ${phrase}.`;
  return quote ? `${base} Keyed on: "${quote}"` : base;
}
