import { createComparisonBudget } from '../../direct-budget.ts';
import { runDirectComparison, type DirectTransport } from '../../direct-run.ts';
import type { HoldoutCase } from '../../direct-holdout-plan.ts';
import { simulatedExecution, type BindingDecision, type ProviderCall } from '../../direct-historical.ts';
import {
  composePublic, type MandatePacket, type OrderUnderReview, type PublicComposition, type V3Toggles,
} from './host.ts';

/**
 * The dry-run executor receives this decision. systemVerdict is the v3
 * public verdict, not the frozen runner verdict. simulatedExecution is the
 * same 45s rule the harness uses.
 */
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
    arm: 'sentinel_b', systemVerdict: verdict, durationMs, providerCalls, reasons: ['order-value-proto/v3'],
  };
  return { systemVerdict: verdict, durationMs, executed: simulatedExecution(decision).executed, providerCalls };
}

export async function runPublicV3(input: {
  row: HoldoutCase;
  content: string;
  mandate: MandatePacket;
  order: OrderUnderReview;
  toggles: V3Toggles;
  budgetUsd?: number;
}): Promise<{
  frozenRunnerVerdict: string | null;
  frozenExecuted: boolean;
  composition: PublicComposition | null;
  executor: ReturnType<typeof executorReceives> | null;
}> {
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
    ? composePublic(input.row.documents, primary, input.mandate, input.order, input.toggles) : null;
  const executor = composition && sentinel
    ? executorReceives(composition.publicVerdict, sentinel.durationMs, sentinel.secondary_called) : null;
  return {
    frozenRunnerVerdict: sentinel?.verdict ?? null,
    frozenExecuted: sentinel?.executed ?? false,
    composition,
    executor,
  };
}
