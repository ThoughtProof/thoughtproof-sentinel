/**
 * Host budget for the grounded-critic comparison.
 * Both arms use these same constants. They do not change the frozen
 * acceptance timeout in model-config.ts.
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
