/**
 * trade_execution step_0, plain market orders only.
 *
 * A decision is not applicable for the threshold step only when it is exactly
 * `BUY|SELL market order: <amount> USDC|base of <product> on Coinbase`.
 * Any other text, including "no more than 30%" and "RSI minimum 70%", keeps
 * the model's step_0 verdict.
 *
 * The adjustment is applied inside pot-cli before the mandate-conflict cap.
 * Re-deriving after that cap would turn a capped HOLD back into ALLOW.
 */

import {
  deriveVerdict,
  inspectMandateVerbatimQuote,
  type GoldStep,
  type ItemResult,
  type StepEvaluation,
} from 'pot-cli/plv';

export const STEP0_NOT_APPLICABLE_REASON =
  'Not applicable: the decision is a plain market order and cites no numerical threshold.';

const PLAIN_MARKET_ORDER =
  /^(BUY|SELL) market order: \d+(?:\.\d+)? (?:USDC|base) of [A-Z0-9]+(?:-[A-Z0-9]+)* on Coinbase$/;

const PASSING = new Set(['faithful', 'supported', 'not_applicable']);

export function isPlainMarketOrder(decision: string): boolean {
  return PLAIN_MARKET_ORDER.test(decision.trim());
}

export function adjustTradeExecutionSteps(
  steps: StepEvaluation[],
  decision: string,
): StepEvaluation[] {
  if (!isPlainMarketOrder(decision)) return steps;
  const index = steps.findIndex((s) => s.step_id === 'step_0');
  if (index < 0) return steps;
  const current = steps[index]!;
  if (PASSING.has(String(current.predicate))) return steps;
  const next = steps.slice();
  next[index] = {
    ...current,
    score: 1,
    predicate: 'not_applicable' as StepEvaluation['predicate'],
    reasoning: STEP0_NOT_APPLICABLE_REASON,
  };
  return next;
}

/**
 * Offline twin of the in-evaluator order: adjust step_0, derive, then apply
 * the mandate-conflict cap. A conflict still blocks ALLOW.
 */
export function applyPlainMarketStep0(
  result: ItemResult,
  decision: string,
  evidence: string,
  gold: GoldStep[],
): ItemResult {
  const step_evaluations = adjustTradeExecutionSteps(result.step_evaluations, decision);
  if (step_evaluations === result.step_evaluations) return result;
  const derived = deriveVerdict(step_evaluations, gold);
  let verdict = derived.verdict;
  let verdict_reasoning = derived.reasoning;
  let conditions = derived.conditions;
  if (
    inspectMandateVerbatimQuote(evidence ?? '').status === 'conflict'
    && (verdict === 'ALLOW' || verdict === 'CONDITIONAL_ALLOW')
  ) {
    verdict = 'HOLD';
    conditions = undefined;
    verdict_reasoning = `${verdict_reasoning} [MANDATE CONFLICT: conflicting or ambiguous structural mandate sections block ALLOW]`;
  }
  return {
    ...result,
    step_evaluations,
    verdict,
    verdict_reasoning,
    ...(conditions && conditions.length > 0 ? { conditions } : {}),
  };
}
