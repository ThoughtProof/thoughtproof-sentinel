import { estimatePromptTokens } from './comparison-budget.ts';
import { MODEL_CONFIG } from './model-config.ts';

/**
 * Shared 1.00 USD cap for both arms, including a Sentinel secondary call.
 *
 * createSpendLedger in comparison-budget.ts is the reservation pattern:
 * reserve before send, replace the reservation when usage is confirmed,
 * and keep it on timeout or missing usage. Its booked() figure mixes
 * measured spend with open reservations, so it cannot report the three
 * amounts separately. This ledger uses the same three operations and
 * stores them apart. It does not change a request body.
 *
 * The next-call estimate prices OUTPUT_ASSUMPTION_TOKENS of output.
 * That is not a ceiling. The historical body has no output limit, and
 * grok-4.7 reasoning tokens are not bounded by max_completion_tokens.
 * maxCallCostUsd is not used: it always prices grok-4.7 and reads
 * max_completion_tokens from the body, which the historical request lacks.
 */
export const SHARED_BUDGET_USD = 1;
export const OUTPUT_ASSUMPTION_TOKENS = 32_768;

/** Raul GO t942u: grok-4-fast-reasoning is billed as grok-4.3 at low. */
const HISTORICAL_INPUT_PER_MILLION = 1.25;
const HISTORICAL_OUTPUT_PER_MILLION = 2.5;

export type BudgetArm = 'sentinel_primary' | 'sentinel_secondary' | 'historical';
export type CallRunStatus = 'result' | 'timeout' | 'error' | 'not_run_budget';
export type PairStatus = 'complete' | 'incomplete_budget';

export interface BudgetSnapshot {
  measured_usd: number;
  open_reservations_usd: number;
  actual_overrun_usd: number;
  closed: boolean;
}

export interface BudgetTicket {
  id: number;
  estimateUsd: number;
}

interface OpenTicket extends BudgetTicket {
  id: number;
}

export function estimateNextCallUsd(arm: BudgetArm, promptText: string): number {
  const promptTokens = estimatePromptTokens(promptText);
  if (arm === 'historical') {
    return (promptTokens * HISTORICAL_INPUT_PER_MILLION + OUTPUT_ASSUMPTION_TOKENS * HISTORICAL_OUTPUT_PER_MILLION) / 1_000_000;
  }
  const pricing = arm === 'sentinel_primary' ? MODEL_CONFIG.primary.pricing : MODEL_CONFIG.cascade.secondary.pricing;
  const band = promptTokens >= pricing.longContextFromPromptTokens ? pricing.longContext : pricing.shortContext;
  return (promptTokens * band.input + OUTPUT_ASSUMPTION_TOKENS * band.output) / 1_000_000;
}

export function createComparisonBudget(capUsd = SHARED_BUDGET_USD) {
  let measured = 0;
  let nextId = 1;
  const open: OpenTicket[] = [];
  let closed = false;

  function openUsd(): number {
    return open.reduce((sum, ticket) => sum + ticket.estimateUsd, 0);
  }

  function snapshot(): BudgetSnapshot {
    return {
      measured_usd: measured,
      open_reservations_usd: openUsd(),
      actual_overrun_usd: Math.max(0, measured - capUsd),
      closed,
    };
  }

  function closeIfExhausted(): void {
    if (measured + openUsd() >= capUsd - 1e-9) closed = true;
  }

  return {
    snapshot,
    /** True when measured spend, open reservations, and the next estimate would pass 1.00 USD. */
    wouldExceed(estimateUsd: number): boolean {
      return measured + openUsd() + estimateUsd > capUsd + 1e-9;
    },
    /** Latches the ledger. Later reservations do not reopen it. */
    latch(): void {
      closed = true;
    },
    tryReserve(estimateUsd: number): BudgetTicket | null {
      if (closed || !Number.isFinite(estimateUsd) || estimateUsd < 0) return null;
      if (measured + openUsd() + estimateUsd > capUsd + 1e-9) {
        closed = true;
        return null;
      }
      const ticket = { id: nextId, estimateUsd };
      nextId += 1;
      open.push(ticket);
      return ticket;
    },
    commitMeasured(ticket: BudgetTicket, measuredUsd: number): void {
      if (!Number.isFinite(measuredUsd) || measuredUsd < 0) return;
      const index = open.findIndex(item => item.id === ticket.id);
      if (index >= 0) open.splice(index, 1);
      measured += measuredUsd;
      closeIfExhausted();
    },
    /** Timeout or missing usage. The reservation stays open. */
    keep(ticket: BudgetTicket): void {
      if (!open.some(item => item.id === ticket.id)) open.push({ id: ticket.id, estimateUsd: ticket.estimateUsd });
      closeIfExhausted();
    },
  };
}

export interface DispatchCall<T> {
  caseId: string;
  arm: BudgetArm;
  promptText: string;
  send: () => Promise<{ measuredUsd: number | null; timeout?: boolean; value: T }>;
}

export interface DispatchRow<T> {
  caseId: string;
  arm: BudgetArm;
  status: CallRunStatus;
  value: T | null;
}

export async function dispatchWithinBudget<T>(
  calls: readonly DispatchCall<T>[],
  budget = createComparisonBudget(),
): Promise<{ rows: DispatchRow<T>[]; budget: BudgetSnapshot; transportCalls: number }> {
  const rows: DispatchRow<T>[] = [];
  let transportCalls = 0;
  for (const call of calls) {
    if (budget.snapshot().closed) {
      rows.push({ caseId: call.caseId, arm: call.arm, status: 'not_run_budget', value: null });
      continue;
    }
    const estimate = estimateNextCallUsd(call.arm, call.promptText);
    if (budget.wouldExceed(estimate)) budget.latch();
    const ticket = budget.snapshot().closed ? null : budget.tryReserve(estimate);
    if (!ticket) {
      budget.latch();
      rows.push({ caseId: call.caseId, arm: call.arm, status: 'not_run_budget', value: null });
      continue;
    }
    try {
      transportCalls += 1;
      const response = await call.send();
      if (response.timeout) {
        budget.keep(ticket);
        rows.push({ caseId: call.caseId, arm: call.arm, status: 'timeout', value: null });
      } else if (response.measuredUsd === null || !Number.isFinite(response.measuredUsd)) {
        budget.keep(ticket);
        rows.push({ caseId: call.caseId, arm: call.arm, status: 'result', value: response.value });
      } else {
        budget.commitMeasured(ticket, response.measuredUsd);
        rows.push({ caseId: call.caseId, arm: call.arm, status: 'result', value: response.value });
      }
    } catch {
      budget.keep(ticket);
      rows.push({ caseId: call.caseId, arm: call.arm, status: 'error', value: null });
    }
  }
  return { rows, budget: budget.snapshot(), transportCalls };
}

export function pairStatus(rows: readonly { caseId: string; arm: BudgetArm; status: CallRunStatus }[], caseId: string): PairStatus {
  const mine = rows.filter(row => row.caseId === caseId && row.arm !== 'sentinel_secondary');
  const sentinel = mine.find(row => row.arm === 'sentinel_primary');
  const historical = mine.find(row => row.arm === 'historical');
  if (sentinel?.status === 'not_run_budget' || historical?.status === 'not_run_budget') return 'incomplete_budget';
  return 'complete';
}

/** A budget gap is not a verdict. A timeout is not a verdict either. */
export function qualityVerdict(pair: PairStatus, status: CallRunStatus, verdict: string | null): string | null {
  if (pair === 'incomplete_budget' || status !== 'result') return null;
  return verdict;
}
