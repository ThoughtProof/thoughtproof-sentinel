import { createComparisonBudget } from '../../direct-budget.ts';
import { runDirectComparison, type DirectTransport } from '../../direct-run.ts';
import type { HoldoutCase } from '../../direct-holdout-plan.ts';
import { composePublic, type AuthorizedLimitsPacket, type OrderUnderReview, type PublicComposition } from './host.ts';

/**
 * Public path. runDirectComparison receives the mocked primary. This layer
 * recomposes the verdict from that same primary, replacing only the
 * order-value member before aggregation. The runner's own verdict stays
 * the frozen one.
 */
export async function runPublicOrderValue(input: {
  row: HoldoutCase;
  content: string;
  packet: AuthorizedLimitsPacket;
  order: OrderUnderReview;
  budgetUsd?: number;
}): Promise<{ frozenRunnerVerdict: string | null; composition: PublicComposition | null; calls: number }> {
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
  const composition = primary.length > 0 ? composePublic(input.row.documents, primary, input.packet, input.order) : null;
  return { frozenRunnerVerdict: sentinel?.verdict ?? null, composition, calls: report.calls };
}
