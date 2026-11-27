import { MODEL_CONFIG } from './model-config.ts';

/**
 * Host budget for the grounded-critic comparison.
 * Both arms use these same constants. They do not change the frozen
 * acceptance timeout in model-config.ts.
 *
 * Dollar reservation follows scripts/cb4a-paid-validation-runner.mjs
 * createPaidRunGuard: reserve the conservative max before dispatch, reconcile
 * down only when a finite measured cost comes back, and keep the reservation
 * after timeout or unknown usage.
 */

/** Total time for one arm's presentation of one case. */
export const PER_CASE_BUDGET_MS = 45_000;

/**
 * Proposed cap for a later 12-call pilot (6 cases × 2 arms).
 * Not a measured spend. The frozen primary price table is the estimator.
 */
export const PROPOSED_PILOT_COST_CAP_USD = 5;

export function exceedsCostCap(spentUsd: number, capUsd: number): boolean {
  return !Number.isFinite(spentUsd) || !Number.isFinite(capUsd) || spentUsd > capUsd;
}

export function overBudget(latencyMs: number, budgetMs: number = PER_CASE_BUDGET_MS): boolean {
  return !Number.isFinite(latencyMs) || latencyMs > budgetMs;
}

/** UTF-8 bytes / 4, rounded up. This is a ceiling, not a tokenizer. */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

/**
 * Conservative max for one call: estimated prompt tokens plus
 * max_completion_tokens, priced on the frozen table. At or above the
 * long-context threshold the long-context rates are used.
 */
export function maxCallCostUsd(promptText: string, maxCompletionTokens: number): number {
  const promptTokens = estimatePromptTokens(promptText);
  const pricing = MODEL_CONFIG.primary.pricing;
  const band = promptTokens >= pricing.longContextFromPromptTokens ? pricing.longContext : pricing.shortContext;
  return (promptTokens * band.input + maxCompletionTokens * band.output) / 1_000_000;
}

export interface Reservation {
  maxUsd: number;
}

export function createSpendLedger(capUsd: number) {
  let booked = 0;
  return {
    booked: () => booked,
    tryReserve(maxUsd: number): Reservation | null {
      if (!Number.isFinite(capUsd) || capUsd <= 0) return null;
      if (!Number.isFinite(maxUsd) || maxUsd < 0) return null;
      if (booked + maxUsd > capUsd + 1e-9) return null;
      booked += maxUsd;
      return { maxUsd };
    },
    reconcile(ticket: Reservation, measuredUsd: number): void {
      if (Number.isFinite(measuredUsd) && measuredUsd >= 0) booked += measuredUsd - ticket.maxUsd;
    },
    /** Timeout or unknown usage. The reservation stays booked. */
    keep(_ticket: Reservation): void {},
  };
}
