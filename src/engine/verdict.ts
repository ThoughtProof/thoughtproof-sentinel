/**
 * Verdict Mapper
 *
 * Maps pot-cli's internal verdict vocabulary to Sentinel's public 3-tier
 * verdict: ALLOW | BLOCK | UNCERTAIN.
 *
 * Pure function. No I/O, no side effects.
 */

import { toPublicVerdict, type InternalVerdict } from 'pot-cli/verdict';
import type { SentinelVerdict, SentinelMode } from '../types.js';

/**
 * Mode-specific verdict overrides.
 *
 * Some modes require stricter mapping than the default pot-cli behavior.
 * For example, trade_execution maps CONDITIONAL_ALLOW → UNCERTAIN because
 * "if in doubt, don't trade" is the correct default for capital-at-risk.
 */
const CONSERVATIVE_MODES: Set<SentinelMode> = new Set<SentinelMode>(['trade_execution', 'trade_reasoning']);

/**
 * trade_reasoning step_2-only promotion (ADR-0018).
 *
 * In trade_reasoning mode, step_0 (thresholds) and step_1 (direction) are the
 * FACTUAL checks — and they are now backstopped by the deterministic structural
 * layer (cb4a-verify hard-BLOCKs direction contradictions and feeds verified
 * facts in as evidence). step_2 is purely INFERENTIAL INTEGRITY (self-
 * coherence). A conservative CONDITIONAL_ALLOW → UNCERTAIN remap that is driven
 * ONLY by a marginal step_2 should not gate the trade: the facts checked out,
 * the reasoning merely wasn't airtight prose.
 *
 * This returns true iff it is SAFE to promote a UNCERTAIN back to ALLOW:
 *   - the two factual steps (0, 1) both clear the SUPPORTED bar, AND
 *   - step_2 is the only weak one.
 * If step_0 or step_1 is weak/failed, we do NOT promote — those are real
 * factual problems. Pure function; caller supplies step (id, score, predicate).
 */
const SUPPORTED_SCORE_BAR = 0.5625; // pot-cli SUPPORTED threshold (graded-support rubric)
const FACTUAL_STEP_IDS = new Set(['step_0', 'step_1']);

export interface StepLite {
  step_id: string;
  score: number;
  predicate: string;
}

function stepPasses(s: StepLite): boolean {
  const p = s.predicate.toLowerCase();
  // Faithfulness "faithful" or graded "supported" clears outright.
  if (p === 'faithful' || p === 'supported') return true;
  // Otherwise require the score to clear the SUPPORTED bar.
  return s.score >= SUPPORTED_SCORE_BAR;
}

export function canPromoteStep2Only(steps: StepLite[]): boolean {
  if (steps.length === 0) return false;
  const factual = steps.filter((s) => FACTUAL_STEP_IDS.has(s.step_id));
  const step2 = steps.find((s) => s.step_id === 'step_2');
  // Need both factual steps present and passing, and a step_2 that exists.
  if (factual.length < 2 || !step2) return false;
  if (!factual.every(stepPasses)) return false;
  // Only promote when step_2 is in fact the weak one (else there's nothing to
  // promote — verdict would already be ALLOW — but this keeps the guard honest).
  return !stepPasses(step2);
}

/**
 * Map pot-cli's internal verdict to Sentinel's public verdict.
 *
 * pot-cli emits: ALLOW | CONDITIONAL_ALLOW | HOLD | BLOCK | DISSENT
 *
 * Default mapping (via pot-cli's toPublicVerdict):
 *   ALLOW / CONDITIONAL_ALLOW → ALLOW
 *   HOLD / DISSENT → UNCERTAIN
 *   BLOCK → BLOCK
 *
 * Conservative modes (trade_execution):
 *   ALLOW → ALLOW
 *   CONDITIONAL_ALLOW → UNCERTAIN  (stricter: doubt = don't execute)
 *   HOLD / DISSENT → UNCERTAIN
 *   BLOCK → BLOCK
 */
export function mapVerdict(internalVerdict: string, mode?: SentinelMode): SentinelVerdict {
  // Conservative modes: CONDITIONAL_ALLOW → UNCERTAIN
  if (mode && CONSERVATIVE_MODES.has(mode) && internalVerdict === 'CONDITIONAL_ALLOW') {
    return 'UNCERTAIN';
  }

  const publicResponse = toPublicVerdict(internalVerdict as InternalVerdict);
  return publicResponse.verdict as SentinelVerdict;
}
