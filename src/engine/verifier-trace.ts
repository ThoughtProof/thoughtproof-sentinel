/** Additive, unsigned surface of actual evaluator stages. Never changes a verdict. */
import type {CascadeOutput} from './cascade.js';
import type {ItemResult} from 'pot-cli/plv';
import type {SentinelVerifierTrace, SentinelVerdict, SentinelVerifyRequest} from '../types.js';
import {normalizeCascadeSteps, sanitizeReasoning, stripProvenanceDowngradeStamp} from '../step-quote-provenance.js';
import {receiptConfidence} from '../confidence.js';
import {bindStepObjections} from '../objection-evidence-bind.js';

/** Same normalization/bind path for the legacy surface and each diagnostic stage. */
export function surfaceEvaluation(
  item: ItemResult, criteria: ReadonlyMap<string, string>, evidence: string, request: SentinelVerifyRequest,
) {
  const normalized = normalizeCascadeSteps(item.step_evaluations, evidence);
  const raw = normalized.map(s => {
    const criterion = criteria.get(s.step_id) ?? '';
    return {step_id: s.step_id, criterion, score: receiptConfidence(s.score), predicate: String(s.predicate),
      quote: s.quote, quote_source: s.quote_source ?? null, quote_match_mode: s.quote ? s.match_mode : null,
      reasoning: s.reasoning.trim() || synthesizeReasoning(String(s.predicate), criterion, s.quote)};
  });
  return {normalized, raw, bind: bindStepObjections(raw, {mandate: request.mandate, claim: request.claim, evidence: request.evidence})};
}

export function buildVerifierTrace(
  cascade: CascadeOutput, criteria: ReadonlyMap<string, string>, evidence: string,
  request: SentinelVerifyRequest, engineVerdict: SentinelVerdict,
): SentinelVerifierTrace | undefined {
  // Old responses cannot reconstruct a discarded primary result. No regex interpretation of prose.
  if (!cascade.evaluations) return undefined;
  const missing: SentinelVerifierTrace['missing_reason_steps'] = [];
  const stages: SentinelVerifierTrace['stages'] = cascade.evaluations.map(stage => {
    if (stage.status !== 'completed' || !stage.item) return {
      stage: stage.stage, model: stage.model, status: stage.status === 'not_invoked' ? 'not_invoked' : 'unavailable',
      verdict: null, reasoning: null, reasoning_source: 'missing', objections: [],
    };
    const item = stage.item, surface = surfaceEvaluation(item, criteria, evidence, request);
    const objections = surface.bind.surface_objections.map((objection, i) => {
      const original = sanitizeReasoning(item.step_evaluations[i].reasoning);
      const present = stripProvenanceDowngradeStamp(original).length > 0;
      if (!present) missing.push({stage: stage.stage, step_id: objection.step_id});
      const source = surface.bind.items[i].surface !== 'pass_through' ? 'evidence_bind' as const
        : surface.normalized[i].reasoning.trim().length === 0 ? 'criterion_fallback' as const
        : surface.normalized[i].reasoning !== original ? 'surface_normalizer' as const : 'evaluator' as const;
      return {...objection, reasoning_source: source, evaluator_reasoning_present: present};
    });
    const reasoning = sanitizeReasoning(item.verdict_reasoning);
    // Stage summaries must not reintroduce numeric claims rejected on the normal objection surface.
    const summary = reasoning ? bindStepObjections([{step_id: 'summary', criterion: 'Evaluator summary',
      score: 0, predicate: 'diagnostic', quote: null, reasoning}],
      {mandate: request.mandate, claim: request.claim, evidence: request.evidence}) : null;
    return {stage: stage.stage, model: stage.model, status: stage.status,
      verdict: item.verdict, reasoning: summary?.surface_objections[0].reasoning || null,
      reasoning_source: !summary ? 'missing' : summary.items[0].surface === 'pass_through' ? 'evaluator' : 'evidence_bind', objections};
  });
  const primary = stages.find(s => s.stage === 'primary');
  const retained = cascade.result.verdict !== 'ALLOW' && cascade.result.verdict !== 'CONDITIONAL_ALLOW'
    && (primary?.verdict === 'HOLD' || primary?.verdict === 'BLOCK')
    && ['primary_hold', 'primary_block', 'primary_block_rejected', 'confirmed_block', 'secondary_error_fallback'].includes(cascade.cascadeReason ?? '');
  return {schema_version: 'sentinel.verifier-trace.v1', signature_scope: 'unsigned_diagnostics',
    cascade_reason: cascade.cascadeReason ?? null, internal_verdict: cascade.result.verdict,
    engine_verdict: engineVerdict, legacy_surface_stage: cascade.surfaceStage ?? null,
    retained_primary_restriction: retained, missing_reason_steps: missing, stages};
}

/** Legacy wording retained; diagnostic provenance identifies this as a criterion-only fallback. */
function synthesizeReasoning(predicate: string, criterion: string, quote: string | null): string {
  const verdictPhrase: Record<string, string> = {
    unsupported: 'failed: the evidence does not support this criterion',
    unfaithful: 'failed: the decision is not faithful to the evidence for this criterion',
    partial: 'only partially met by the evidence', weakly_faithful: 'only weakly supported by the evidence',
    partially_faithful: 'only partially faithful to the evidence', supported: 'met by the evidence',
    faithful: 'faithful to the evidence', skipped: 'was not evaluated',
  };
  const phrase = verdictPhrase[predicate] ?? `evaluated as "${predicate}"`;
  const base = criterion ? `Criterion "${criterion}" was ${phrase}.` : `This step was ${phrase}.`;
  return quote ? `${base} Keyed on: "${quote}"` : base;
}
