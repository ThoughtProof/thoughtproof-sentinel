/**
 * Re-score recorded model JSON through pot-cli 0.8.13 provenance and
 * deriveVerdict. No model call. The nano contract is the same module the
 * vendored patch uses, so aliasing matches production when the flag is on.
 */
import {
  applyScoreFloors,
  coerceQuote,
  deriveVerdict,
  inspectMandateVerbatimQuote,
  recoverCiteableQuote,
  verifyProvenance,
  type GoldStep,
  type ItemResult,
  type StepEvaluation,
  type SupportTier,
} from 'pot-cli/plv';
import {
  isNanoModel,
  normalizeNanoStepArray,
} from '../../vendor/pot-cli-0.8.13/nano-step-contract.js';

export interface ReplayOutcome {
  malformed: boolean;
  reasons: string[];
  result: ItemResult | null;
}

function blank(stepId: string): StepEvaluation {
  return {
    step_id: stepId,
    score: 0,
    tier: 'none',
    quote: null,
    quote_location: { line_start: null, line_end: null, char_offset_start: null, char_offset_end: null, turn: null },
    quote_to_criterion_mapping: null,
    reasoning: 'Step not evaluated (missing from both tiers)',
    abstain_if_uncertain: true,
    predicate: 'skipped',
  };
}

function asStep(raw: Record<string, unknown>, stepId: string): StepEvaluation {
  const score = typeof raw.score === 'number' ? raw.score : Number(raw.score);
  const tier = typeof raw.tier === 'string' ? raw.tier : 'none';
  const predicate = typeof raw.predicate === 'string' ? raw.predicate : 'unfaithful';
  return {
    step_id: stepId,
    score: Number.isFinite(score) ? score : 0,
    tier: tier as SupportTier,
    quote: coerceQuote(raw.quote),
    quote_location: {
      line_start: null,
      line_end: null,
      char_offset_start: null,
      char_offset_end: null,
      turn: null,
    },
    quote_to_criterion_mapping: null,
    reasoning: raw.reasoning == null ? '' : String(raw.reasoning),
    abstain_if_uncertain: raw.abstain_if_uncertain === true,
    predicate: predicate as StepEvaluation['predicate'],
  };
}

/**
 * Same array extraction as pot-cli's evaluator parse. Returns null when the
 * text is not a JSON array.
 */
export function parseRecordedStepArray(text: string): unknown[] | null {
  const safe = text == null ? '' : String(text);
  const stripped = safe.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
  const start = stripped.indexOf('[{');
  const end = stripped.lastIndexOf('}]');
  try {
    if (start !== -1 && end !== -1 && end > start) {
      const parsed = JSON.parse(stripped.slice(start, end + 2)) as unknown;
      if (Array.isArray(parsed)) return parsed;
    }
    const match = stripped.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function replayFaithfulness(
  rawSteps: unknown,
  evidence: string,
  gold: GoldStep[],
  opts: { nanoStepContract: boolean; model: string },
): ReplayOutcome {
  let steps: unknown = rawSteps;
  if (opts.nanoStepContract && isNanoModel(opts.model)) {
    const normalized = normalizeNanoStepArray(rawSteps);
    if (normalized.malformed) {
      return { malformed: true, reasons: normalized.reasons, result: null };
    }
    steps = normalized.steps;
  }
  if (!Array.isArray(steps)) {
    return { malformed: true, reasons: ['response is not an array'], result: null };
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const step of steps) {
    if (step && typeof step === 'object' && !Array.isArray(step)) {
      const id = (step as { step_id?: unknown }).step_id;
      if (typeof id === 'string') byId.set(id, step as Record<string, unknown>);
    }
  }

  const merged = gold.map((g) => {
    const stepId = `step_${g.index}`;
    const raw = byId.get(stepId);
    return raw ? asStep(raw, stepId) : blank(stepId);
  });

  const mandateConflict = inspectMandateVerbatimQuote(evidence ?? '').status === 'conflict';
  const processed = merged.map((ev) => {
    const evForProv = { ...ev, quote: recoverCiteableQuote(coerceQuote(ev.quote), evidence ?? '') };
    const violations = verifyProvenance(evForProv, evidence ?? '');
    let next = { ...evForProv };
    const hard = violations.filter((v) => v.startsWith('PROV_FAIL_01') || v.startsWith('PROV_FAIL_02'));
    if (hard.length > 0) {
      next.score = Math.min(next.score, 0.25);
      next.predicate = 'unsupported';
    }
    return applyScoreFloors(next, evidence ?? '', 'faithfulness');
  });

  const derived = deriveVerdict(processed, gold);
  let verdict = derived.verdict;
  let verdict_reasoning = derived.reasoning;
  if (mandateConflict && (verdict === 'ALLOW' || verdict === 'CONDITIONAL_ALLOW')) {
    verdict = 'HOLD';
    verdict_reasoning = `${verdict_reasoning} [MANDATE CONFLICT]`;
  }
  return {
    malformed: false,
    reasons: [],
    result: {
      id: 'replay',
      step_evaluations: processed,
      verdict,
      verdict_reasoning,
      provenance_violations: [],
      ...(derived.conditions && derived.conditions.length > 0 ? { conditions: derived.conditions } : {}),
    },
  };
}
