/**
 * trade_execution reading of plain orders.
 *
 * The model criteria in modes/trade_execution.ts tell a future call that a
 * missing threshold (step 0) and a missing justification (step 2) are not
 * failures. This module is the deterministic reading of a decision that
 * already came back. It does not call a model.
 *
 * Product rule:
 *   BLOCK when the text proves a contradiction (direction, a fabricated
 *   justification, a contradicted threshold, or a mandate conflict).
 *   UNCERTAIN when the evidence is not enough to check a cited threshold,
 *   or when a plain order's direction step was scored unfaithful even
 *   though the thesis does not contradict the order.
 *   ALLOW only for a plain market order whose thesis matches the side,
 *   whose mandate sections do not conflict, and which states no
 *   fabricated justification.
 */

export type PublicTradeVerdict = 'ALLOW' | 'BLOCK' | 'UNCERTAIN';

export type PlainOrderReason =
  | 'not_applicable'
  | 'mandate_conflict'
  | 'direction_contradiction'
  | 'fabricated_justification'
  | 'threshold_contradicted'
  | 'threshold_unchecked'
  | 'direction_insufficient'
  | 'plain_order_clear';

export interface TradeStepLike {
  step_id: string;
  predicate: string;
  score: number;
  reasoning?: string;
}

export interface PlainOrderAssessment {
  plain: boolean;
  thresholdCited: boolean;
  thresholdContradicted: boolean;
  direction: 'conflict' | 'aligned' | 'insufficient';
  fabrication: boolean;
  mandateConflict: boolean;
}

export interface PlainOrderDecision<T extends TradeStepLike> {
  applied: boolean;
  publicVerdict: PublicTradeVerdict;
  reason: PlainOrderReason;
  reasoning: string;
  steps: T[];
  assessment: PlainOrderAssessment;
}

export const STEP0_ABSENCE_REASON =
  'Not applicable: the decision cites no numerical threshold. Absence is not a failure.';

export const STEP2_ABSENCE_REASON =
  'Not applicable: the decision states no justification beyond the order. Absence is not fabrication.';

const PLAIN_MARKET_ORDER =
  /^(BUY|SELL) market order: \d+(?:\.\d+)? (?:USDC|base) of [A-Z0-9]+(?:-[A-Z0-9]+)* on Coinbase$/;

const THRESHOLD_LANGUAGE =
  /no more than|at most|\bbelow\b|\bmax\b|≤|<=|at least|\bminimum\b|\babove\b|≥|>=|\bRSI\b/i;

const BULLISH = [/uptrend/i, /rising/i, /higher/i, /support holds/i, /bounce/i];
const BEARISH = [/downtrend/i, /falling/i, /\blower\b/i, /breakdown/i, /selloff/i];

const FAILING = new Set(['unfaithful', 'unsupported', 'skipped']);

const SECTION_HEADER =
  /^(Mandate|Principal instruction|Thesis|Reasoning)\s*:\s*(.*)$/i;

export function isPlainMarketOrder(decision: string): boolean {
  return PLAIN_MARKET_ORDER.test(decision.trim());
}

/**
 * Mandate and principal-instruction bodies, using the same section headers
 * the resolver compares. Empty when the evidence has neither section.
 * This does not change the resolver's inputs or its verdict rules.
 */
export function tradeMandateBodies(evidence: string): { mandate: string; instruction: string } | null {
  const parts = sections(evidence ?? '');
  const mandate = parts.get('mandate') ?? '';
  const instruction = parts.get('principal instruction') ?? '';
  if (!mandate && !instruction) return null;
  return { mandate, instruction };
}

function sections(evidence: string): Map<string, string> {
  const found = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of evidence.split(/\r?\n/)) {
    const header = line.match(SECTION_HEADER);
    if (header) {
      current = header[1]!.toLowerCase();
      const rest = header[2] ?? '';
      found.set(current, rest ? [rest] : []);
      continue;
    }
    if (current) found.get(current)!.push(line);
  }
  const out = new Map<string, string>();
  for (const [key, lines] of found) out.set(key, lines.join('\n').trim());
  return out;
}

function directionOf(text: string, side: 'BUY' | 'SELL' | null): PlainOrderAssessment['direction'] {
  const bullish = BULLISH.some((pattern) => pattern.test(text));
  const bearish = BEARISH.some((pattern) => pattern.test(text));
  if (bullish === bearish) return 'insufficient';
  if (!side) return 'insufficient';
  if (side === 'BUY' && bearish) return 'conflict';
  if (side === 'SELL' && bullish) return 'conflict';
  if (side === 'BUY' && bullish) return 'aligned';
  if (side === 'SELL' && bearish) return 'aligned';
  return 'insufficient';
}

function fabricatedJustification(parts: Map<string, string>): boolean {
  const reasoning = parts.get('reasoning');
  if (!reasoning) return false;
  const thesis = (parts.get('thesis') ?? '').toLowerCase();
  const tokens = reasoning.match(/\d+(?:\.\d+)?%?|\b[a-z]{5,}\b/gi) ?? [];
  return tokens.some((token) => !thesis.includes(token.toLowerCase()));
}

/** A cited upper or lower bound that an evidence number misses. */
function thresholdContradicted(claim: string, evidence: string): boolean {
  const evidenceNumbers = [...evidence.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (evidenceNumbers.length === 0) return false;
  const upper = claim.match(/(?:no more than|at most|below|max|≤|<=)\s*(\d+(?:\.\d+)?)/i);
  const lower = claim.match(/(?:at least|minimum|above|≥|>=|RSI minimum)\s*(\d+(?:\.\d+)?)/i);
  if (upper) {
    const bound = Number(upper[1]);
    if (evidenceNumbers.some((value) => value > bound)) return true;
  }
  if (lower) {
    const bound = Number(lower[1]);
    if (evidenceNumbers.some((value) => value < bound)) return true;
  }
  return false;
}

export function assessTradeExecution(claim: string, evidence: string): PlainOrderAssessment {
  const text = claim.trim();
  const plain = isPlainMarketOrder(text);
  const parts = sections(evidence ?? '');
  const thesis = parts.get('thesis') ?? evidence ?? '';
  const side = /^(BUY|SELL)\b/.exec(text)?.[1] as 'BUY' | 'SELL' | undefined;
  const mandate = parts.get('mandate') ?? '';
  const instruction = parts.get('principal instruction') ?? '';
  return {
    plain,
    thresholdCited: !plain && (THRESHOLD_LANGUAGE.test(text) || /\d/.test(text)),
    thresholdContradicted: thresholdContradicted(text, evidence ?? ''),
    direction: directionOf(thesis, side ?? null),
    fabrication: fabricatedJustification(parts),
    mandateConflict: mandate.length > 0 && instruction.length > 0 && mandate !== instruction,
  };
}

function rewrite<T extends TradeStepLike>(
  steps: T[],
  stepId: string,
  predicate: string,
  score: number,
  reasoning: string,
): T[] {
  return steps.map((step) =>
    step.step_id === stepId ? { ...step, predicate, score, reasoning } : step,
  );
}

function adjustSteps<T extends TradeStepLike>(steps: T[], assessment: PlainOrderAssessment): T[] {
  let next = steps.map((step) => ({ ...step }));
  const failing = (stepId: string) =>
    FAILING.has(String(next.find((step) => step.step_id === stepId)?.predicate ?? ''));

  if (assessment.plain) {
    if (failing('step_0')) next = rewrite(next, 'step_0', 'not_applicable', 1, STEP0_ABSENCE_REASON);
    if (!assessment.fabrication && failing('step_2')) {
      next = rewrite(next, 'step_2', 'not_applicable', 1, STEP2_ABSENCE_REASON);
    }
  }
  if (assessment.fabrication) {
    const step2 = next.find((step) => step.step_id === 'step_2');
    if (step2 && step2.predicate !== 'unfaithful') {
      next = rewrite(
        next,
        'step_2',
        'unfaithful',
        0,
        'The Reasoning section cites a fact that is not in the Thesis.',
      );
    }
  }
  if (assessment.direction === 'conflict') {
    const step1 = next.find((step) => step.step_id === 'step_1');
    if (step1 && step1.predicate !== 'unfaithful') {
      next = rewrite(
        next,
        'step_1',
        'unfaithful',
        0,
        'The order side contradicts the directional claim in the thesis.',
      );
    }
  }
  if (
    assessment.thresholdCited
    && !assessment.thresholdContradicted
    && assessment.direction !== 'conflict'
    && !assessment.mandateConflict
    && !assessment.fabrication
    && failing('step_0')
  ) {
    next = rewrite(
      next,
      'step_0',
      'weakly_faithful',
      0.5,
      'A threshold is cited and the evidence has no number that confirms or contradicts it.',
    );
    if (failing('step_2')) next = rewrite(next, 'step_2', 'not_applicable', 1, STEP2_ABSENCE_REASON);
  }
  return next;
}

/**
 * Read a trade_execution decision. `applied` is false when the claim is
 * neither a plain order nor a cited threshold and the evidence proves
 * nothing on its own; the caller keeps the model verdict.
 */
export function resolveTradeExecutionPlainOrder<T extends TradeStepLike>(
  claim: string,
  evidence: string,
  steps: T[],
): PlainOrderDecision<T> {
  const assessment = assessTradeExecution(claim, evidence);
  const handled = assessment.plain
    || assessment.thresholdCited
    || assessment.mandateConflict
    || assessment.fabrication
    || assessment.direction === 'conflict';
  if (!handled) {
    return {
      applied: false,
      publicVerdict: 'UNCERTAIN',
      reason: 'not_applicable',
      reasoning: '',
      steps,
      assessment,
    };
  }

  const adjusted = adjustSteps(steps, assessment);
  const step1 = adjusted.find((step) => step.step_id === 'step_1');
  let reason: PlainOrderReason;
  let publicVerdict: PublicTradeVerdict;
  if (assessment.mandateConflict) {
    reason = 'mandate_conflict';
    publicVerdict = 'BLOCK';
  } else if (assessment.direction === 'conflict') {
    reason = 'direction_contradiction';
    publicVerdict = 'BLOCK';
  } else if (assessment.fabrication) {
    reason = 'fabricated_justification';
    publicVerdict = 'BLOCK';
  } else if (assessment.thresholdCited && assessment.thresholdContradicted) {
    reason = 'threshold_contradicted';
    publicVerdict = 'BLOCK';
  } else if (assessment.thresholdCited) {
    reason = 'threshold_unchecked';
    publicVerdict = 'UNCERTAIN';
  } else if (assessment.plain && step1?.predicate === 'unfaithful') {
    reason = 'direction_insufficient';
    publicVerdict = 'UNCERTAIN';
  } else if (assessment.plain && assessment.direction === 'aligned') {
    reason = 'plain_order_clear';
    publicVerdict = 'ALLOW';
  } else {
    reason = 'direction_insufficient';
    publicVerdict = 'UNCERTAIN';
  }

  return {
    applied: true,
    publicVerdict,
    reason,
    reasoning: reasoningFor(reason),
    steps: adjusted,
    assessment,
  };
}

function reasoningFor(reason: PlainOrderReason): string {
  switch (reason) {
    case 'mandate_conflict':
      return 'BLOCK: Mandate and Principal instruction disagree, so the order is not allowed.';
    case 'direction_contradiction':
      return 'BLOCK: the order side contradicts the directional claim in the thesis.';
    case 'fabricated_justification':
      return 'BLOCK: a stated justification cites a fact that is not in the thesis.';
    case 'threshold_contradicted':
      return 'BLOCK: the evidence number misses the threshold the decision cites.';
    case 'threshold_unchecked':
      return 'UNCERTAIN: the decision cites a threshold and the evidence has no number that confirms or contradicts it.';
    case 'direction_insufficient':
      return 'UNCERTAIN: the direction step does not confirm the order, and the thesis does not prove the opposite either.';
    case 'plain_order_clear':
      return 'ALLOW: plain market order, the thesis matches the side, and nothing in the text contradicts it.';
    default:
      return '';
  }
}
