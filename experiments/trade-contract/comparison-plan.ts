import { casesFor, type CaseSplit } from './comparison-cases.ts';
import { maxCallCostUsd } from './comparison-budget.ts';
import { buildArmRequest } from './comparison-run.ts';
import { COMPARISON_BASELINE, type ComparisonArm } from './comparison-prompt.ts';

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
