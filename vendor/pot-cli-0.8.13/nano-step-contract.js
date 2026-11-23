/**
 * Sentinel vendored contract for serv-nano faithfulness steps (pot-cli 0.8.13).
 *
 * The published evaluator prompt is unchanged. When Sentinel opts in
 * (`nanoStepContract`), serv-nano calls append the strict suffix below and
 * this module normalizes the parsed JSON before provenance runs.
 *
 * coerceQuote is not modified. A step that has a score and reasoning (or a
 * quote) but no quote still goes through PROV_FAIL_01 / PROV_FAIL_02.
 *
 * Malformed, after aliasing, means any of:
 *   - a score that is not a finite number in [0, 1] (strings are not coerced)
 *   - neither non-empty reasoning nor a non-empty quote
 *   - when expected step ids are supplied: a missing id, a duplicate id,
 *     or an id that was not requested
 * Explicit null quotes are absent quotes. `reason` is accepted as
 * `reasoning`. `predicate` is recomputed from the score and is never required.
 * An incomplete list is malformed and must be retried, not scored.
 */

export const MALFORMED_NANO_STEP_MARKER = 'sentinel-malformed-nano-step';

export const NANO_STRICT_OUTPUT_SUFFIX = `

STRICT OUTPUT CONTRACT (mandatory, overrides any ambiguity above):
Return ONLY a JSON array with exactly one object per STEP_ID listed in the request. No prose, no markdown.
Every object MUST contain ALL of the following keys, always - never omit a key:
  "step_id": string, exactly as given (e.g. "step_0")
  "score": number between 0.0 and 1.0
  "predicate": one of "faithful" | "partially_faithful" | "weakly_faithful" | "unfaithful"
  "reasoning": non-empty string, 1-2 sentences explaining the score for THIS step
  "quote": EITHER an exact, character-for-character substring copied from the TRACE EXCERPT (no paraphrase, no ellipsis, no added quotation marks), OR the JSON literal null if no supporting span exists
If score >= 0.75, "quote" must be a non-null exact substring. A reply missing any key is invalid.`;

export class MalformedNanoStepError extends Error {
  /**
   * @param {string[]} reasons
   */
  constructor(reasons) {
    super(`[${MALFORMED_NANO_STEP_MARKER}] ${reasons.join('; ')}`);
    this.name = 'MalformedNanoStepError';
    this.reasons = reasons;
  }
}

/**
 * @param {string} model
 */
export function isNanoModel(model) {
  return typeof model === 'string' && /(^|[^a-z])nano([^a-z]|$)/i.test(model);
}

/**
 * Faithfulness predicate bands. Matches applyScoreFloors' faithfulness remap
 * before the quote check (quote-less scores >= 0.75 are still labeled
 * faithful here; provenance and floors cap them afterwards).
 *
 * @param {number} score
 */
export function faithfulnessPredicateFromScore(score) {
  if (score >= 0.75) return 'faithful';
  if (score >= 0.5625) return 'partially_faithful';
  if (score >= 0.25) return 'weakly_faithful';
  return 'unfaithful';
}

/**
 * @param {unknown} value
 */
function nonEmptyText(value) {
  if (typeof value !== 'string') return false;
  const t = value.trim();
  return t.length > 0 && t !== 'undefined' && t !== 'null';
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function unitIntervalScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

/**
 * @param {unknown} step
 * @returns {{ step: Record<string, unknown>, malformed: boolean, reason: string }}
 */
export function normalizeNanoStep(step) {
  if (step == null || typeof step !== 'object' || Array.isArray(step)) {
    return { step: {}, malformed: true, reason: 'step is not an object' };
  }
  const out = { .../** @type {Record<string, unknown>} */ (step) };
  if (!nonEmptyText(out.reasoning) && nonEmptyText(out.reason)) {
    out.reasoning = String(out.reason).trim();
  }
  const score = unitIntervalScore(out.score);
  const id = typeof out.step_id === 'string' ? out.step_id : '?';
  if (score == null) {
    return { step: out, malformed: true, reason: `${id} score is not a finite number in [0,1]` };
  }
  out.score = score;
  // Do not trust the model's predicate. serv-nano emits verdict: pass/fail
  // or an invalid predicate string. Floors recompute again after provenance.
  out.predicate = faithfulnessPredicateFromScore(score);
  const hasReasoning = nonEmptyText(out.reasoning);
  const hasQuote = nonEmptyText(out.quote);
  if (!hasReasoning && !hasQuote) {
    return {
      step: out,
      malformed: true,
      reason: `${id} has neither reasoning nor quote`,
    };
  }
  return { step: out, malformed: false, reason: '' };
}

/**
 * @param {unknown} steps
 * @param {readonly string[] | undefined} expectedIds step ids the request asked for.
 *   When set, the array must contain each id once and no others.
 * @returns {{ steps: Record<string, unknown>[], malformed: boolean, reasons: string[] }}
 */
export function normalizeNanoStepArray(steps, expectedIds) {
  if (!Array.isArray(steps)) {
    return { steps: [], malformed: true, reasons: ['response is not an array'] };
  }
  const reasons = [];
  const seen = new Set();
  const out = steps.map((step) => {
    const n = normalizeNanoStep(step);
    const id = typeof n.step.step_id === 'string' ? n.step.step_id : '';
    if (!id) reasons.push('step is missing step_id');
    else if (seen.has(id)) reasons.push(`${id} is duplicated`);
    else seen.add(id);
    if (expectedIds && id && !expectedIds.includes(id)) {
      reasons.push(`${id} is not an expected step`);
    }
    if (n.malformed) reasons.push(n.reason);
    return n.step;
  });
  if (expectedIds) {
    for (const id of expectedIds) {
      if (!seen.has(id)) reasons.push(`${id} is missing`);
    }
  } else if (out.length === 0) {
    reasons.push('no steps');
  }
  return { steps: out, malformed: reasons.length > 0, reasons };
}
