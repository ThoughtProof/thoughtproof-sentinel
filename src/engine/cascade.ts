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
import { MALFORMED_NANO_STEP_MARKER } from '../../vendor/pot-cli-0.8.13/nano-step-contract.js';

import { runCascade, type CascadeConfig } from 'pot-cli/cascade';
import type { CascadeTraceStep, SentinelTier } from '../types.js';
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
  /**
   * trade_execution only. Asks the vendored pot-cli patch to use the strict
   * nano contract. Other modes leave the published evaluator untouched.
   */
  nanoStepContract?: boolean;
}

export interface CascadeOutput {
  result: ItemResult;
  modelsUsed: string[];
  cascadeReason?: string;
  /** pot-cli cascade degradedMode (primary/secondary error paths). */
  degradedMode?: boolean;
  /** True if cascade completed under budget without abort. */
  budget_ok?: boolean;
  /** Cascade error strings (primary_error_fallback and similar). */
  cascadeErrors?: string[];
  /**
   * True when the primary threw MalformedNanoStepError and the secondary ran.
   * HTTP 401/429/5xx are primary errors too, but they are not this flag.
   */
  malformedStepFallback?: boolean;
  /**
   * Model whose step_evaluations are on the receipt. This is the secondary
   * only when that call returned a result. A swift call that was attempted
   * and failed leaves the primary's steps, so this stays serv-nano.
   */
  stepModel?: string;
  /**
   * trade_execution only. Deep copy of each model's steps, taken when the
   * cascade returns and before the receipt or the plain-order resolver
   * rewrites them. Absent for every other mode.
   */
  modelTrace?: {
    cascadeReason: string | null;
    primaryVerdict: string | null;
    secondaryVerdict: string | null;
    stepsSource: string;
    primarySteps: CascadeTraceStep[];
    secondarySteps: CascadeTraceStep[] | null;
  };
}

/** Copy step fields into a frozen list. Later edits of the source do not land here. */
export function snapshotCascadeSteps(
  steps: Array<{ step_id?: string; predicate?: string; score?: number; reasoning?: string; quote?: string | null }> | undefined,
): CascadeTraceStep[] {
  const copied = (steps ?? []).map((step) => Object.freeze({
    step_id: String(step.step_id ?? ''),
    predicate: String(step.predicate ?? ''),
    score: typeof step.score === 'number' && Number.isFinite(step.score) ? step.score : 0,
    reasoning: typeof step.reasoning === 'string' ? step.reasoning : '',
    quote: step.quote == null || String(step.quote).trim() === '' ? null : String(step.quote),
  }));
  return Object.freeze(copied);
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
    ...(input.nanoStepContract ? { nanoStepContract: true } : {}),
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
        malformedStepFallback: false,
        stepModel: stages[0],
        ...(input.nanoStepContract
          ? {
              modelTrace: {
                cascadeReason: null,
                primaryVerdict: result.verdict,
                secondaryVerdict: null,
                stepsSource: stages[0],
                primarySteps: snapshotCascadeSteps(result.step_evaluations),
                secondarySteps: null,
              },
            }
          : {}),
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

    // Snapshot before the receipt adopts one model's steps and before any
    // later resolver rewrite. primary is nano even when baseItem is swift.
    const tracedPrimarySteps = snapshotCascadeSteps(cr.primary?.step_evaluations);
    const tracedSecondarySteps = cr.secondary
      ? snapshotCascadeSteps(cr.secondary.step_evaluations)
      : null;

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
    // Receipt steps are secondary's only when that result exists. secondaryInvoked
    // stays true when swift was called and threw (secondary_error_fallback).
    const stepModel = cr.secondary ? stages[1] : stages[0];

    const cascadeErrors = cr.errors ?? [];
    return {
      result,
      modelsUsed,
      cascadeReason: cr.reason,
      degradedMode: cr.degradedMode === true,
      budget_ok: true,
      cascadeErrors,
      malformedStepFallback: cascadeErrors.some((e) => e.includes(MALFORMED_NANO_STEP_MARKER)),
      stepModel,
      ...(input.nanoStepContract
        ? {
            modelTrace: {
              cascadeReason: cr.reason,
              primaryVerdict: cr.primary?.verdict ?? null,
              secondaryVerdict: cr.secondary?.verdict ?? null,
              stepsSource: stepModel,
              primarySteps: tracedPrimarySteps,
              secondarySteps: tracedSecondarySteps,
            },
          }
        : {}),
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
