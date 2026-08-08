/**
 * Sentinel Cascade Runner
 *
 * Executes verification through pot-cli's cascade or solo evaluation.
 * Pure computation — takes config + mode output, returns results.
 *
 * Sentinel tiers:
 * - checkpoint: Nano solo (1 model call)
 * - standard: Nano→Pro cascade (1-2 model calls)
 *
 * Reliability Option 3: optional AbortSignal + engine budget race on each
 * provider call. Late results after abort never decide the outcome.
 */

import {
  evaluateItem,
  type EvalInput,
  type EvalOptions,
  type ItemResult,
  type EvalMode,
} from 'pot-cli/plv';

import { runCascade, type CascadeConfig } from 'pot-cli/cascade';
import type { SentinelTier } from '../types.js';
import { TIER_CONFIGS } from '../tiers.js';
import {
  EngineBudgetExhaustedError,
  raceAgainstBudget,
  type BudgetStage,
} from './budget.js';

export interface CascadeInput {
  evalInput: EvalInput;
  evalMode: EvalMode;
  tier: SentinelTier;
  /** Engine budget abort — when aborted, in-flight eval is abandoned. */
  signal?: AbortSignal;
  /** Wall-clock start for elapsed reporting (defaults to now). */
  budgetStartedAt?: number;
  budgetMs?: number;
}

export interface CascadeOutput {
  result: ItemResult;
  modelsUsed: string[];
  cascadeReason?: string;
  /** pot-cli cascade degradedMode (primary/secondary error paths). */
  degradedMode?: boolean;
  /** True if cascade completed under budget without abort. */
  budget_ok?: boolean;
}

/**
 * Run verification through the appropriate cascade for the given tier.
 *
 * - checkpoint: Nano solo (single evaluateItem call)
 * - standard: Nano→Pro cascade (runCascade with early-exit)
 */
export async function runSentinelCascade(input: CascadeInput): Promise<CascadeOutput> {
  const tierConfig = TIER_CONFIGS[input.tier];
  const stages = tierConfig.cascade;
  const startedAt = input.budgetStartedAt ?? Date.now();
  const budgetMs = input.budgetMs;
  const signal = input.signal;

  const evalOptions: EvalOptions = {
    mode: input.evalMode,
    maxTokens: 4096,
  };

  // Partial knowledge for budget exhaustion: only BLOCK is preservable.
  let knownInternalVerdict: string | null = null;
  let stage: BudgetStage = 'pre_cascade';
  const modelsUsedAcc: string[] = [];

  const evaluate = async (modelAlias: string, evalInput: EvalInput): Promise<ItemResult> => {
    // Infer stage from call order for standard cascade.
    if (stages.length === 1) {
      stage = 'solo';
    } else if (!modelsUsedAcc.includes(stages[0])) {
      stage = 'primary';
    } else {
      stage = 'secondary';
    }

    const work = evaluateItem(evalInput, modelAlias, evalOptions).then((result) => {
      // Record restrictive knowledge only after successful completion.
      if (result.verdict === 'BLOCK') {
        knownInternalVerdict = 'BLOCK';
      }
      if (!modelsUsedAcc.includes(modelAlias)) {
        modelsUsedAcc.push(modelAlias);
      }
      return result;
    });

    if (!signal) {
      return work;
    }

    return raceAgainstBudget(work, {
      signal,
      stage,
      startedAt,
      budgetMs,
      knownInternalVerdict: () => knownInternalVerdict,
      modelsUsed: () => [...modelsUsedAcc],
    });
  };

  try {
    // Checkpoint: single model, no cascade
    if (stages.length === 1) {
      const result = await evaluate(stages[0], input.evalInput);
      return {
        result,
        modelsUsed: [stages[0]],
        budget_ok: true,
      };
    }

    // Standard: Nano→Pro cascade
    const cascadeConfig: CascadeConfig = {
      primaryModel: stages[0],
      secondaryModel: stages[1],
      // confirmBlocks: opt-in only (CONFIRM_BLOCKS=1). Default OFF.
      confirmBlocks: process.env.CONFIRM_BLOCKS === '1',
    };

    const cr = await runCascade(input.evalInput, evaluate, cascadeConfig);
    const baseItem = cr.secondary ?? cr.primary;

    if (!baseItem) {
      throw new Error(`[sentinel-cascade] no item result for ${input.evalInput.id}`);
    }

    // Cascade final verdict may be BLOCK even if intermediate steps differed.
    if (cr.verdict === 'BLOCK') {
      knownInternalVerdict = 'BLOCK';
    }

    const result: ItemResult = {
      ...baseItem,
      verdict: cr.verdict,
      verdict_reasoning: `${baseItem.verdict_reasoning}\n\n[sentinel-cascade ${cr.reason}: primary=${cr.primary?.verdict ?? 'ERR'}${cr.secondary ? `, secondary=${cr.secondary.verdict}` : ''}]`,
    };

    const modelsUsed: string[] = [stages[0]];
    if (cr.secondaryInvoked && stages[1]) {
      modelsUsed.push(stages[1]);
    }

    return {
      result,
      modelsUsed,
      cascadeReason: cr.reason,
      degradedMode: cr.degradedMode === true,
      budget_ok: true,
    };
  } catch (err) {
    if (err instanceof EngineBudgetExhaustedError) {
      // Enrich with latest partial knowledge collected in this runner.
      throw new EngineBudgetExhaustedError({
        stage: err.stage || stage,
        elapsedMs: err.elapsedMs,
        budgetMs: err.budgetMs,
        knownInternalVerdict: knownInternalVerdict ?? err.knownInternalVerdict,
        modelsUsed: modelsUsedAcc.length ? modelsUsedAcc : err.modelsUsed,
      });
    }
    // If abort raced a non-budget error, still surface budget if signal aborted.
    if (signal?.aborted) {
      throw new EngineBudgetExhaustedError({
        stage,
        elapsedMs: Date.now() - startedAt,
        budgetMs,
        knownInternalVerdict,
        modelsUsed: modelsUsedAcc,
      });
    }
    throw err;
  }
}
