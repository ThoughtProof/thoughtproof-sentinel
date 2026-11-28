import { createComparisonBudget } from '../../direct-budget.ts';
import { runDirectComparison, type DirectTransport } from '../../direct-run.ts';
import type { HoldoutCase } from '../../direct-holdout-plan.ts';
import { simulatedExecution, type BindingDecision, type ProviderCall } from '../../direct-historical.ts';
import {
  EXECUTABLE_MODE, composePublic, rejectUnsafe,
  type MandatePacket, type OrderUnderReview, type PublicComposition, type SafeMode,
} from './host.ts';

export function executorReceives(verdict: PublicComposition['publicVerdict'], durationMs: number, secondaryCalled: boolean): {
  systemVerdict: PublicComposition['publicVerdict'];
  durationMs: number;
  executed: boolean;
  providerCalls: ProviderCall[];
} {
  const providerCalls: ProviderCall[] = [
    { stage: 'primary', model: 'grok-4.7', status: 'completed' },
    { stage: 'secondary', model: 'grok-4.3', status: secondaryCalled ? 'completed' : 'not_sent' },
  ];
  const decision: BindingDecision = {
    arm: 'sentinel_b', systemVerdict: verdict, durationMs, providerCalls, reasons: ['order-value-proto/v4'],
  };
  return { systemVerdict: verdict, durationMs, executed: simulatedExecution(decision).executed, providerCalls };
}

/** Diagnostic composition. It does not call the executor. */
export function composeDiagnostic(
  documents: HoldoutCase['documents'], content: string, mandate: MandatePacket,
  order: OrderUnderReview, mode: SafeMode,
): PublicComposition {
  return composePublic(documents, content, mandate, order, rejectUnsafe(mode));
}

/**
 * The only executable entry. The mode is fixed: every applicable host
 * clause is enforced, and only then may the quantity grounding release run.
 */
export async function runPublicV4(input: {
  row: HoldoutCase;
  content: string;
  mandate: MandatePacket;
  order: OrderUnderReview;
  budgetUsd?: number;
}): Promise<{
  frozenRunnerVerdict: string | null;
  frozenExecuted: boolean;
  composition: PublicComposition | null;
  executor: ReturnType<typeof executorReceives> | null;
}> {
  rejectUnsafe(EXECUTABLE_MODE);
  let primary = '';
  const transport: DirectTransport = {
    async send(request) {
      if (request.arm === 'sentinel_primary') {
        primary = input.content;
        return { ok: true, content: input.content, usageUsd: 0 };
      }
      return { ok: true, content: '{"execute":false,"verdict":"BLOCK"}', usageUsd: 0 };
    },
  };
  const report = await runDirectComparison({
    cases: [input.row],
    transport,
    budget: createComparisonBudget(input.budgetUsd ?? 100),
  });
  const sentinel = report.outcomes.find(outcome => outcome.system === 'sentinel');
  const composition = primary.length > 0
    ? composePublic(input.row.documents, primary, input.mandate, input.order, EXECUTABLE_MODE) : null;
  const executor = composition && sentinel
    ? executorReceives(composition.publicVerdict, sentinel.durationMs, sentinel.secondary_called) : null;
  return {
    frozenRunnerVerdict: sentinel?.verdict ?? null,
    frozenExecuted: sentinel?.executed ?? false,
    composition,
    executor,
  };
}
