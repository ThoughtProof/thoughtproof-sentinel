/**
 * Sentinel Cascade Runner
 *
 * Executes verification through pot-cli's cascade or solo evaluation.
 * Pure computation — takes config + mode output, returns results.
 *
 * Sentinel tiers:
 * - checkpoint: Nano solo (1 model call)
 * - standard: Nano→Pro cascade (1-2 model calls)
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

export interface CascadeInput {
  evalInput: EvalInput;
  evalMode: EvalMode;
  tier: SentinelTier;
}

export interface CascadeOutput {
  result: ItemResult;
  modelsUsed: string[];
  cascadeReason?: string;
  /** pot-cli cascade degradedMode (primary/secondary error paths). */
  degradedMode?: boolean;
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

  const evalOptions: EvalOptions = {
    mode: input.evalMode,
    maxTokens: 4096,
  };

  const evaluate = (modelAlias: string, evalInput: EvalInput) =>
    evaluateItem(evalInput, modelAlias, evalOptions);

  // Checkpoint: single model, no cascade
  if (stages.length === 1) {
    const result = await evaluate(stages[0], input.evalInput);
    return {
      result,
      modelsUsed: [stages[0]],
    };
  }

  // Standard: Nano→Pro cascade
  const cascadeConfig: CascadeConfig = {
    primaryModel: stages[0],
    secondaryModel: stages[1],
    // confirmBlocks (2026-07-08, env-gated, DEFAULT OFF): when CONFIRM_BLOCKS=1,
    // a primary=BLOCK no longer early-exits but is confirmed by the secondary
    // (mirrors the existing HOLD disagreement logic). Addresses verdict
    // non-determinism where an unstable nano-solo BLOCK decided a capital block
    // alone (79% of live BLOCKs were nano-solo). primary_block_rejected → HOLD →
    // UNCERTAIN in trade_execution (no silent pass-through; verified: no HOLD→ALLOW
    // promotion path in that mode). Default OFF → byte-identical to prior behaviour.
    // See pot-cli fix/cascade-confirm-block + RCA docs/sentinel-verdict-nondeterminism-rca-2026-07-08.md
    confirmBlocks: process.env.CONFIRM_BLOCKS === "1",
  };

  const cr = await runCascade(input.evalInput, evaluate, cascadeConfig);
  const baseItem = cr.secondary ?? cr.primary;

  if (!baseItem) {
    throw new Error(`[sentinel-cascade] no item result for ${input.evalInput.id}`);
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
  };
}
