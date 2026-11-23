/**
 * trade_execution step-quality counters.
 *
 * One structured log line per verification, plus a warn when a rolling share
 * crosses a threshold. There is no pager and no paid suite trigger. The log
 * query is docs/trade-execution-step-quality.md.
 *
 * Counts are in-process (one isolate). A log drain should aggregate the
 * per-request lines; the rolling share is a same-process hook for tests and
 * for a single warm instance.
 */

export const TRADE_EXECUTION_QUALITY_EVENT = 'sentinel.trade_execution.step_quality';
export const TRADE_EXECUTION_QUALITY_ALERT = 'sentinel.trade_execution.step_quality_alert';

/** Rolling window and the smallest sample that may alert. */
export const TRADE_EXECUTION_QUALITY_WINDOW = 100;
export const TRADE_EXECUTION_QUALITY_MIN_SAMPLES = 20;

/**
 * Shares at or above these values alert. primary_block at 0.90 is the Sep 2026
 * serv-nano failure (about 100% primary_block) and sits well above the July
 * mixed rate (about 30%).
 */
export const TRADE_EXECUTION_QUALITY_THRESHOLDS = {
  templated_reasoning_share: 0.8,
  null_quote_share: 0.8,
  malformed_fallback_share: 0.5,
  primary_block_share: 0.9,
} as const;

export type TradeExecutionQualityMetric = keyof typeof TRADE_EXECUTION_QUALITY_THRESHOLDS;

export interface TradeExecutionStepFlag {
  /** Sentinel synthesized the objection because the model prose was empty. */
  templatedReasoning: boolean;
  /** Model quote was null or absent. Mandate recovery is not counted as present. */
  nullQuote: boolean;
}

export interface TradeExecutionQualitySample {
  verificationId: string;
  /** Model whose steps are on the receipt. */
  surfacedModel: string;
  /** Cascade primary. primary_block and malformed fallback are attributed here. */
  primaryModel: string;
  cascadeReason: string | null;
  malformedStepFallback: boolean;
  steps: TradeExecutionStepFlag[];
}

export interface TradeExecutionQualityAlert {
  metric: TradeExecutionQualityMetric;
  model: string;
  share: number;
  threshold: number;
  n: number;
}

interface ModelBucket {
  requests: number[];
  templatedSteps: number[];
  stepCounts: number[];
  nullQuotes: number[];
  malformed: number[];
  primaryBlock: number[];
  above: Record<TradeExecutionQualityMetric, boolean>;
}

function emptyBucket(): ModelBucket {
  return {
    requests: [],
    templatedSteps: [],
    stepCounts: [],
    nullQuotes: [],
    malformed: [],
    primaryBlock: [],
    above: {
      templated_reasoning_share: false,
      null_quote_share: false,
      malformed_fallback_share: false,
      primary_block_share: false,
    },
  };
}

let cascadeErrorCount = 0;
const buckets = new Map<string, ModelBucket>();

export function tradeExecutionCascadeErrorCount(): number {
  return cascadeErrorCount;
}

function bucket(model: string): ModelBucket {
  let b = buckets.get(model);
  if (!b) {
    b = emptyBucket();
    buckets.set(model, b);
  }
  return b;
}

function push(arr: number[], value: number): void {
  arr.push(value);
  if (arr.length > TRADE_EXECUTION_QUALITY_WINDOW) arr.shift();
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

export interface TradeExecutionQualityShares {
  requests: number;
  steps: number;
  templated_reasoning_share: number | null;
  null_quote_share: number | null;
  malformed_fallback_share: number | null;
  primary_block_share: number | null;
}

export function tradeExecutionQualityShares(model: string): TradeExecutionQualityShares {
  const b = buckets.get(model);
  if (!b) {
    return {
      requests: 0,
      steps: 0,
      templated_reasoning_share: null,
      null_quote_share: null,
      malformed_fallback_share: null,
      primary_block_share: null,
    };
  }
  const requests = b.requests.length;
  const steps = sum(b.stepCounts);
  return {
    requests,
    steps,
    templated_reasoning_share: steps > 0 ? sum(b.templatedSteps) / steps : null,
    null_quote_share: steps > 0 ? sum(b.nullQuotes) / steps : null,
    malformed_fallback_share: requests > 0 ? sum(b.malformed) / requests : null,
    primary_block_share: requests > 0 ? sum(b.primaryBlock) / requests : null,
  };
}

function consider(
  model: string,
  b: ModelBucket,
  metric: TradeExecutionQualityMetric,
  share: number | null,
  n: number,
  alerts: TradeExecutionQualityAlert[],
): void {
  const threshold = TRADE_EXECUTION_QUALITY_THRESHOLDS[metric];
  const hot = share != null && n >= TRADE_EXECUTION_QUALITY_MIN_SAMPLES && share >= threshold;
  if (hot && !b.above[metric]) {
    alerts.push({ metric, model, share: share as number, threshold, n });
  }
  b.above[metric] = hot;
}

/**
 * UNCERTAIN, transport errors, and 401/429/5xx are never an ALLOW.
 * Used by the offline re-score as well as the cascade tests.
 */
export function countsAsAllow(
  verdict: string | null | undefined,
  httpStatus?: number | null,
): boolean {
  if (httpStatus != null && (httpStatus === 401 || httpStatus === 429 || httpStatus >= 500)) {
    return false;
  }
  return verdict === 'ALLOW';
}

export function resetTradeExecutionQualityForTests(): void {
  buckets.clear();
  cascadeErrorCount = 0;
}

/**
 * Both models failed before any receipt existed. Steps are not attributed.
 */
export function recordTradeExecutionCascadeError(
  sample: { verificationId: string; primaryModel: string; secondaryModel: string | null },
  log: (line: string) => void = (line) => console.log(line),
): void {
  cascadeErrorCount += 1;
  log(JSON.stringify({
    event: TRADE_EXECUTION_QUALITY_EVENT,
    verification_id: sample.verificationId,
    cascade_error: true,
    step_model: null,
    surfaced_model: null,
    primary_model: sample.primaryModel,
    secondary_model: sample.secondaryModel,
    steps: 0,
    templated_reasoning_steps: 0,
    null_or_absent_quotes: 0,
    malformed_step_fallback: false,
    primary_block: false,
  }));
}

/**
 * Record one trade_execution verification and emit the log line.
 * Returns alerts that just crossed a threshold (also written to console.warn).
 */
export function recordTradeExecutionStepQuality(
  sample: TradeExecutionQualitySample,
  log: (line: string) => void = (line) => console.log(line),
  warn: (line: string) => void = (line) => console.warn(line),
): TradeExecutionQualityAlert[] {
  const templated = sample.steps.filter((s) => s.templatedReasoning).length;
  const nullQuotes = sample.steps.filter((s) => s.nullQuote).length;
  const primaryBlock = sample.cascadeReason === 'primary_block';

  // Quote and templated-reasoning shares belong to the model that wrote the
  // steps on the receipt. A swift fallback must not be counted as nano.
  const surfaced = bucket(sample.surfacedModel);
  push(surfaced.requests, 1);
  push(surfaced.stepCounts, sample.steps.length);
  push(surfaced.templatedSteps, templated);
  push(surfaced.nullQuotes, nullQuotes);
  const sameModel = sample.surfacedModel === sample.primaryModel;
  push(surfaced.malformed, sameModel && sample.malformedStepFallback ? 1 : 0);
  push(surfaced.primaryBlock, sameModel && primaryBlock ? 1 : 0);
  if (!sameModel) {
    const primary = bucket(sample.primaryModel);
    push(primary.requests, 1);
    push(primary.stepCounts, 0);
    push(primary.templatedSteps, 0);
    push(primary.nullQuotes, 0);
    push(primary.malformed, sample.malformedStepFallback ? 1 : 0);
    push(primary.primaryBlock, primaryBlock ? 1 : 0);
  }

  const alerts: TradeExecutionQualityAlert[] = [];
  const sharesByModel: Record<string, TradeExecutionQualityShares> = {};
  const models = new Set<string>([sample.primaryModel, sample.surfacedModel]);
  for (const model of models) {
    const b = bucket(model);
    const shares = tradeExecutionQualityShares(model);
    sharesByModel[model] = shares;
    consider(model, b, 'templated_reasoning_share', shares.templated_reasoning_share, shares.steps, alerts);
    consider(model, b, 'null_quote_share', shares.null_quote_share, shares.steps, alerts);
    consider(
      model,
      b,
      'malformed_fallback_share',
      shares.malformed_fallback_share,
      shares.requests,
      alerts,
    );
    consider(model, b, 'primary_block_share', shares.primary_block_share, shares.requests, alerts);
  }

  log(JSON.stringify({
    event: TRADE_EXECUTION_QUALITY_EVENT,
    verification_id: sample.verificationId,
    surfaced_model: sample.surfacedModel,
    primary_model: sample.primaryModel,
    cascade_reason: sample.cascadeReason,
    step_model: sample.surfacedModel,
    steps: sample.steps.length,
    templated_reasoning_steps: templated,
    null_or_absent_quotes: nullQuotes,
    malformed_step_fallback: sample.malformedStepFallback,
    primary_block: primaryBlock,
    rolling: sharesByModel,
  }));

  for (const alert of alerts) {
    warn(JSON.stringify({
      event: TRADE_EXECUTION_QUALITY_ALERT,
      ...alert,
    }));
  }
  return alerts;
}
