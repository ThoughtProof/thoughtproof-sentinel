import { casesFor, type CaseSplit } from './comparison-cases.ts';
import { PER_CASE_BUDGET_MS, maxCallCostUsd } from './comparison-budget.ts';
import { buildArmRequest } from './comparison-run.ts';
import { COMPARISON_BASELINE, type ComparisonArm } from './comparison-prompt.ts';
import { DEV_V3_VERSION, tradeOrderCases } from './dev-v3/cases.ts';

const ARMS: readonly ComparisonArm[] = ['A', 'B'];

export interface CallPlan {
  baseline: typeof COMPARISON_BASELINE;
  kind: 'pilot' | 'schema-smoke';
  split: CaseSplit;
  maxCalls: number;
  costCeilingUsd: number;
  caseIds: string[];
}

function plan(kind: CallPlan['kind'], split: CaseSplit): CallPlan {
  const selected = casesFor(split);
  let costCeilingUsd = 0;
  for (const item of selected) {
    for (const arm of ARMS) {
      const body = buildArmRequest(item.documents, arm);
      costCeilingUsd += maxCallCostUsd(JSON.stringify(body), body.max_completion_tokens);
    }
  }
  return {
    baseline: COMPARISON_BASELINE,
    kind,
    split,
    maxCalls: selected.length * ARMS.length,
    costCeilingUsd,
    caseIds: selected.map(item => item.caseId),
  };
}

export function pilotPlan(): CallPlan {
  return plan('pilot', 'pilot');
}

/** Dev cases only. Pilot ids are not in this plan. */
export function schemaSmokePlan(): CallPlan {
  return plan('schema-smoke', 'dev');
}

export interface TradeOrderCallEstimate {
  caseId: string;
  arm: ComparisonArm;
  estimateUsd: number;
}

export interface TradeOrderPlan {
  selector: 'trade-order-dev';
  version: typeof DEV_V3_VERSION;
  /** Git SHA of the tree under test. Not read from a model response. */
  head: string;
  caseIds: string[];
  arms: readonly ComparisonArm[];
  maxCalls: number;
  timeoutMs: number;
  calls: TradeOrderCallEstimate[];
  costCeilingUsd: number;
  /** The 1 USD cap is soft. A sent call is not undone if reasoning tokens exceed the estimate. */
  costLimit: { usd: number; kind: 'soft'; reason: string };
}

/** Trade orders only. Does not read sealed labels or a provider key. */
export function tradeOrderPlan(head: string): TradeOrderPlan {
  const selected = tradeOrderCases();
  const calls: TradeOrderCallEstimate[] = [];
  let costCeilingUsd = 0;
  for (const item of selected) {
    for (const arm of ARMS) {
      const body = buildArmRequest(item.documents, arm);
      const estimateUsd = maxCallCostUsd(JSON.stringify(body), body.max_completion_tokens);
      calls.push({ caseId: item.caseId, arm, estimateUsd });
      costCeilingUsd += estimateUsd;
    }
  }
  return {
    selector: 'trade-order-dev',
    version: DEV_V3_VERSION,
    head,
    caseIds: selected.map(item => item.caseId),
    arms: ARMS,
    maxCalls: selected.length * ARMS.length,
    timeoutMs: PER_CASE_BUDGET_MS,
    calls,
    costCeilingUsd,
    costLimit: {
      usd: 1,
      kind: 'soft',
      reason: 'A single call may exceed the 1.00 USD cap. max_completion_tokens does not bound grok-4.7 reasoning tokens. '
        + 'Further calls are not sent once cumulative actual cost plus the next pre-send estimate would exceed 1.00 USD.',
    },
  };
}
