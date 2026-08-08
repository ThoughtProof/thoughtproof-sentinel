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
import { mapVerdict, canPromoteStep2Only, resolveActionAuthPromotion } from './verdict.js';
import { runAuthorizationGate, type GateMode } from './authorization-gate.js';
import { bindStepObjections } from '../objection-evidence-bind.js';
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

  // 0. Deterministic authorization gate (ADR-0019 follow-up). Only runs for
  //    action_authorization with a machine-readable mandate. It hard-checks the
  //    BINARY, UNFIXABLE authority violations the LLM cascade is unreliable on
  //    (arithmetic overshoot, recipient identity, unlimited approval) — the
  //    same neuro-symbolic split cb4a-verify uses. Default gateMode 'shadow':
  //    compute + attach, do NOT gate. 'enforce': a violation short-circuits to
  //    BLOCK before spending the LLM cascade. By construction the gate can only
  //    ADD blocks on unambiguous violations, never allow — so it cannot create
  //    a false ALLOW.
  const gateMode: GateMode = req.gateMode ?? 'shadow';
  const gateResult =
    req.mode === 'action_authorization'
      ? runAuthorizationGate(req.mandate, gateMode)
      : null;

  const gateField = gateResult && !gateResult.silent
    ? {
        mode: gateResult.mode,
        wouldBlock: gateResult.wouldBlock,
        enforced: gateResult.enforcedVerdict !== null,
        violations: gateResult.violations,
      }
    : undefined;

  // 0b. Enforce-mode short-circuit: a hard violation BLOCKs without spending the
  //     cascade (cb4a structural pre-check pattern). Shadow mode never gates here.
  if (gateResult && gateResult.enforcedVerdict === 'BLOCK') {
    const reason =
      'Deterministic authorization gate: ' +
      gateResult.violations.map((v) => v.detail).join(' ');
    return {
      id,
      verdict: 'BLOCK',
      confidence: 1,
      reasoning: reason,
      objections: gateResult.violations.map((v, i) => ({
        step_id: `gate_${v.kind}`,
        criterion: `Deterministic authorization gate: ${v.kind}`,
        score: 0,
        predicate: 'unauthorized',
        quote: null,
        reasoning: v.detail,
      })),
      mode: req.mode,
      tier,
      gate: gateField,
      meta: {
        duration_ms: Date.now() - startMs,
        models_used: [],
        verified_at: new Date().toISOString(),
        ...(req.agent_context ? { agent_context: req.agent_context } : {}),
      },
    };
  }

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
  const internalVerdict = cascadeOutput.result.verdict;
  let verdict = mapVerdict(internalVerdict, req.mode);
  let promotionMeta: SentinelVerifyResponse['meta']['promotion'] | undefined;

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

  // 3c. action_authorization promotion (ADR-0019 + 2026-08-08 addendum).
  //     Sentinel promotion layer only — cascade already emits HOLD for
  //     primary_block_rejected. Do NOT promote that to ALLOW. Bare
  //     agreement_conditional_allow stays REVIEW without machine proof.
  //     agreement_allow unchanged. Exception intentionally fail-closed.
  if (req.mode === 'action_authorization') {
    const decision = resolveActionAuthPromotion({
      mode: req.mode,
      internalVerdict,
      cascadeReason: cascadeOutput.cascadeReason ?? null,
      mappedVerdict: verdict,
      steps: steps3b.map((s) => ({
        step_id: s.step_id,
        score: s.score,
        predicate: String(s.predicate),
      })),
      // No structured proof contract yet — never pass LLM text here.
      machineConditionProof: null,
    });
    verdict = decision.publicVerdict;
    promotionMeta = {
      cascade_reason: decision.trace.cascade_reason,
      internal_verdict: decision.trace.internal_verdict,
      mapped_verdict: decision.trace.mapped_verdict,
      public_verdict: decision.trace.public_verdict,
      promoted: decision.promoted,
      reason: decision.reason,
      steps_all_pass: decision.trace.steps_all_pass,
      machine_condition_proof_present: decision.trace.machine_condition_proof_present,
      machine_condition_proof_accepted: decision.trace.machine_condition_proof_accepted,
      // Deploy provenance: Vercel sets VERCEL_GIT_COMMIT_SHA; local/dev may set
      // GIT_COMMIT / RELEASE_ID. Policy id is stable for this ADR addendum.
      release_id:
        process.env.VERCEL_GIT_COMMIT_SHA ||
        process.env.GIT_COMMIT ||
        process.env.RELEASE_ID ||
        undefined,
      policy: 'adr-0019-cascade-promotion-2026-08-08',
    };
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

  const rawObjections = steps.map((s) => {
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

  // 5b. Objection evidence bind (surface gate only — verdict unchanged).
  // Numeric specialist reasons are claims; where checkable against mandate /
  // claim+evidence bound fields, strip or rewrite fabricated exceed/within text
  // before client / replan / attest surfaces see them. Paris class: 583 ≤ 600
  // must never ship as "exceeds budget".
  const bind = bindStepObjections(rawObjections, {
    mandate: req.mandate,
    claim: req.claim,
    evidence: req.evidence,
  });
  const objections = bind.surface_objections;

  const durationMs = Date.now() - startMs;

  return {
    id,
    verdict,
    confidence: Math.round(avgScore * 1000) / 1000,
    reasoning: cascadeOutput.result.verdict_reasoning,
    objections,
    mode: req.mode,
    tier,
    gate: gateField,
    meta: {
      duration_ms: durationMs,
      models_used: cascadeOutput.modelsUsed,
      verified_at: new Date().toISOString(),
      ...(bind.surface_gated
        ? {
            objection_evidence_bind: {
              surface_gated: true,
              n_evidence_fail: bind.n_evidence_fail,
              n_unverified: bind.n_unverified,
              n_verified: bind.n_verified,
              codes: bind.codes,
              verdict_unchanged: true as const,
            },
          }
        : {}),
      ...(promotionMeta ? { promotion: promotionMeta } : {}),
      ...(req.agent_context ? { agent_context: req.agent_context } : {}),
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
