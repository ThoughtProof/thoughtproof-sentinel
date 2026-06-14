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
import { mapVerdict } from './verdict.js';
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

  // 3. Map verdict (mode-aware: trade_execution is conservative)
  const verdict = mapVerdict(cascadeOutput.result.verdict, req.mode);

  // 4. Calculate confidence from step scores
  const steps = cascadeOutput.result.step_evaluations;
  const avgScore = steps.length > 0
    ? steps.reduce((sum, s) => sum + s.score, 0) / steps.length
    : 0;

  // 5. Surface per-step objections (the actionable substance). pot-cli
  //    already computed these; we slim them to client-relevant fields.
  const objections = steps.map((s) => ({
    step_id: s.step_id,
    score: Math.round(s.score * 1000) / 1000,
    predicate: String(s.predicate),
    quote: s.quote,
    reasoning: s.reasoning,
  }));

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
