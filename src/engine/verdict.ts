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
const CONSERVATIVE_MODES: Set<SentinelMode> = new Set<SentinelMode>([
  'trade_execution',
  'trade_reasoning',
  'action_authorization',
]);

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
 * action_authorization all-steps-pass eligibility (ADR-0019).
 *
 * Returns true iff EVERY step passes. Eligibility alone is NOT sufficient for
 * public ALLOW after the 2026-08-08 addendum — see resolveActionAuthPromotion.
 */
export function canPromoteAllStepsPass(steps: StepLite[]): boolean {
  if (steps.length === 0) return false;
  return steps.every(stepPasses);
}

/**
 * ADR-0019 cascade-promotion decision (Sentinel promotion layer only).
 *
 * Public Sentinel verdict remains ALLOW | BLOCK | UNCERTAIN.
 * REVIEW in product language maps to UNCERTAIN on the wire.
 *
 * Hard invariants (2026-08-08 addendum):
 * 1. primary_block_rejected (primary=BLOCK, secondary∈ALLOW/CONDITIONAL_ALLOW)
 *    → internal HOLD already; NEVER promote to ALLOW via all-steps-pass.
 * 2. agreement_conditional_allow without machine condition-proof → REVIEW.
 * 3. Structured proof exception is intentionally NOT implemented yet
 *    (fail-closed). No LLM prose / step score can activate it.
 * 4. agreement_allow stays ALLOW (003/005 are a separate semantic track).
 * 5. Cascade reason + internal + public verdicts stay in the decision trace.
 */
export type ActionAuthPromotionReason =
  | 'not_action_authorization'
  | 'already_allow'
  | 'already_block'
  | 'primary_block_disagreement'
  | 'conditional_allow_no_machine_proof'
  | 'steps_not_all_pass'
  | 'promoted_all_steps_pass'
  | 'no_promote_path';

export interface ActionAuthPromotionInput {
  mode: SentinelMode | string;
  /** Cascade internal verdict before public remap (ALLOW/CONDITIONAL_ALLOW/HOLD/BLOCK/…). */
  internalVerdict: string;
  /** Cascade reason tag (e.g. primary_block_rejected, agreement_conditional_allow). */
  cascadeReason?: string | null;
  /** Public verdict after mapVerdict, before promotion. */
  mappedVerdict: SentinelVerdict;
  steps: StepLite[];
  /**
   * Machine-checkable condition proof. Intentionally unused until a structured
   * proof contract exists. Must NEVER be inferred from LLM text.
   */
  machineConditionProof?: MachineConditionProof | null;
}

/**
 * Structured machine condition-proof contract (placeholder).
 * Not accepted from free-form LLM text. Fail-closed until a real contract lands.
 */
export interface MachineConditionProof {
  /** Schema marker — unknown/missing kinds are rejected. */
  kind: string;
  /** Explicit fulfillment flag — must be true under a known kind. */
  fulfilled: boolean;
}

export interface ActionAuthPromotionDecision {
  /** Public verdict after promotion policy. */
  publicVerdict: SentinelVerdict;
  /** Whether all-steps-pass promotion actually fired. */
  promoted: boolean;
  reason: ActionAuthPromotionReason;
  /** Trace fields for meta / debugging. */
  trace: {
    cascade_reason: string | null;
    internal_verdict: string;
    mapped_verdict: SentinelVerdict;
    public_verdict: SentinelVerdict;
    steps_all_pass: boolean;
    machine_condition_proof_present: boolean;
    machine_condition_proof_accepted: boolean;
  };
}

/** Cascade reasons that encode primary=BLOCK with secondary allow-class. */
const PRIMARY_BLOCK_DISAGREEMENT_REASONS = new Set([
  'primary_block_rejected',
  // Defensive aliases if naming drifts.
  'primary_block_override',
  'primary_block_disagreement',
]);

/**
 * Accept machine condition-proof ONLY via structured contract.
 * Fail-closed: no known contract yet → always false.
 * Explicitly rejects free-form strings / LLM-shaped objects.
 */
export function acceptsMachineConditionProof(
  proof: MachineConditionProof | null | undefined | unknown,
): boolean {
  // Fail-closed: structured proof contract not shipped yet.
  // When a contract lands, gate on known kind + fulfilled===true only.
  // LLM text / arbitrary objects must never activate the exception.
  void proof;
  return false;
}

export function resolveActionAuthPromotion(
  input: ActionAuthPromotionInput,
): ActionAuthPromotionDecision {
  const cascadeReason = input.cascadeReason ?? null;
  const stepsAllPass = canPromoteAllStepsPass(input.steps);
  const proofPresent = input.machineConditionProof != null;
  const proofAccepted = acceptsMachineConditionProof(input.machineConditionProof ?? null);

  const baseTrace = {
    cascade_reason: cascadeReason,
    internal_verdict: input.internalVerdict,
    mapped_verdict: input.mappedVerdict,
    steps_all_pass: stepsAllPass,
    machine_condition_proof_present: proofPresent,
    machine_condition_proof_accepted: proofAccepted,
  };

  const finish = (
    publicVerdict: SentinelVerdict,
    promoted: boolean,
    reason: ActionAuthPromotionReason,
  ): ActionAuthPromotionDecision => ({
    publicVerdict,
    promoted,
    reason,
    trace: { ...baseTrace, public_verdict: publicVerdict },
  });

  if (input.mode !== 'action_authorization') {
    return finish(input.mappedVerdict, false, 'not_action_authorization');
  }

  // Hard stop: primary BLOCK disagreement must never promote to ALLOW.
  // Cascade already maps this to HOLD → UNCERTAIN; do not lift it.
  // Exact reason-set only — no free-string / substring prefixes in a safety gate.
  if (cascadeReason != null && PRIMARY_BLOCK_DISAGREEMENT_REASONS.has(cascadeReason)) {
    return finish('UNCERTAIN', false, 'primary_block_disagreement');
  }

  // CONDITIONAL_ALLOW must be gated BEFORE any mapped-ALLOW passthrough.
  // A mis-mapped CONDITIONAL_ALLOW→ALLOW must not escape as already_allow.
  const isConditionalAllow =
    input.internalVerdict === 'CONDITIONAL_ALLOW' ||
    cascadeReason === 'agreement_conditional_allow';

  if (isConditionalAllow && !proofAccepted) {
    // No structured machine proof yet → stay REVIEW. Exception not implemented.
    return finish('UNCERTAIN', false, 'conditional_allow_no_machine_proof');
  }

  // Currently unreachable (acceptsMachineConditionProof always false).
  if (isConditionalAllow && proofAccepted && canPromoteAllStepsPass(input.steps)) {
    return finish('ALLOW', true, 'promoted_all_steps_pass');
  }

  if (input.mappedVerdict === 'ALLOW') {
    // agreement_allow path: already public ALLOW — leave unchanged.
    // Reached only when internal is not CONDITIONAL_ALLOW / agreement_conditional_allow.
    return finish('ALLOW', false, 'already_allow');
  }

  if (input.mappedVerdict === 'BLOCK') {
    return finish('BLOCK', false, 'already_block');
  }

  // From here: mapped UNCERTAIN (HOLD/DISSENT or conservative remap leftovers).
  if (!stepsAllPass) {
    return finish('UNCERTAIN', false, 'steps_not_all_pass');
  }

  // No remaining safe promote path under the 2026-08-08 addendum.
  // (Previously: CONDITIONAL_ALLOW + all-steps-pass → ALLOW. That is closed.)
  return finish('UNCERTAIN', false, 'no_promote_path');
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
