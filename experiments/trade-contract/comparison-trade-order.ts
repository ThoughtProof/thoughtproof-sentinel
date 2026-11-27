import { ADAPTER_ID, decideCascade } from './adapter.ts';
import { maxCallCostUsd } from './comparison-budget.ts';
import { prepareModelContent } from './comparison-grounding.ts';
import { sendPaidExchange, type PaidEnv } from './comparison-paid.ts';
import { tradeOrderPlan, type TradeOrderPlan } from './comparison-plan.ts';
import type { ComparisonArm } from './comparison-prompt.ts';
import { saveRawResponse } from './comparison-raw.ts';
import { armCaseRow, type ArmCaseRow, type GateVerdict, type ParserResult, type ProviderStatus } from './comparison-report.ts';
import { bookCallCost, nextCallExceedsSoftCap, SCHEMA_SMOKE_PAID } from './comparison-smoke.ts';
import { buildArmRequest } from './comparison-run.ts';
import { tradeOrderCases } from './dev-v2/cases.ts';

const ARMS: readonly ComparisonArm[] = ['A', 'B'];

export interface TradeOrderRow extends ArmCaseRow {
  /** Wall time until the provider body was fully read. Null when nothing was sent. */
  durationMs: number | null;
  /** Check that decides the frozen verdict, from the gate after the body is parsed. */
  decisiveReason: string | null;
  expected: GateVerdict | null;
  sealedCheckId: string | null;
  sealedStatus: string | null;
}

export interface TradeOrderReport {
  selector: 'trade-order-dev';
  head: string;
  maxCalls: number;
  timeoutMs: number;
  calls_sent: number;
  cumulativeCostUsd: number;
  softCapNote: string;
  rows: TradeOrderRow[];
}

export function tradeOrderSelectorConflict(args: readonly string[]): boolean {
  if (!args.includes('--trade-order-dev')) return false;
  return args.includes('--schema-smoke') || args.includes('--plan') || args.includes('--recorded') || args.includes('--pilot');
}

function decisiveReason(documents: ReturnType<typeof tradeOrderCases>[number]['documents'], content: string): string | null {
  const prepared = prepareModelContent(content, documents, 'primary');
  const gated = decideCascade(documents, { ok: true, content: prepared.publicContent }, null, {
    trustedAdapterIds: [ADAPTER_ID],
    diagnostics: true,
  });
  const contradicted = gated.checks.find(check => check.status === 'contradicted');
  if (contradicted) return `${contradicted.checkId} contradicted`;
  const unverifiable = gated.checks.find(check => check.status === 'not_verifiable');
  if (!unverifiable) return null;
  return `${unverifiable.checkId} not_verifiable`;
}

/**
 * Sealed labels are loaded here, after requests have been built and sent.
 * Request construction does not import this module's label file.
 */
async function attachSealed(rows: TradeOrderRow[]): Promise<TradeOrderRow[]> {
  const { ORDER_LABELS } = await import('./dev-v2/labels.ts');
  return rows.map(row => {
    const label = ORDER_LABELS.find(item => item.caseId === row.caseId);
    return {
      ...row,
      expected: label?.expected ?? null,
      sealedCheckId: label?.decisiveCheckId ?? null,
      sealedStatus: label?.decisiveStatus ?? null,
    };
  });
}

/**
 * Paid trade-order run. Selects only `tradeOrderCases()`. No retry loop.
 * The 1 USD cap is soft: the next call is skipped when booked cost plus the
 * next estimate would exceed it. A sent call can still cost more, because
 * max_completion_tokens does not bound grok-4.7 reasoning tokens.
 */
export async function runTradeOrderDev(
  env: PaidEnv,
  fetchImpl: typeof fetch,
  options: { head: string; saveRawDir?: string; softCapUsd?: number; timeoutMs?: number } ,
): Promise<TradeOrderReport> {
  if (!env.XAI_API_KEY) throw new Error('PAID_PILOT_REFUSED: XAI_API_KEY is not set');
  const cap = options.softCapUsd ?? SCHEMA_SMOKE_PAID.budgetUsd;
  const timeoutMs = options.timeoutMs ?? SCHEMA_SMOKE_PAID.timeoutMs;
  const plan = tradeOrderPlan(options.head);
  const rows: TradeOrderRow[] = [];
  let cumulativeUsd = 0;
  let stopForCap = false;
  let calls = 0;
  for (const item of tradeOrderCases()) {
    if (stopForCap || calls >= plan.maxCalls) break;
    for (const arm of ARMS) {
      if (stopForCap || calls >= plan.maxCalls) break;
      const body = buildArmRequest(item.documents, arm);
      const estimate = maxCallCostUsd(JSON.stringify(body), body.max_completion_tokens);
      if (nextCallExceedsSoftCap(cumulativeUsd, estimate, cap)) {
        stopForCap = true;
        const skipped = armCaseRow({ caseId: item.caseId, arm, providerStatus: 'not_sent' });
        rows.push({ ...skipped, durationMs: null, decisiveReason: null, expected: null, sealedCheckId: null, sealedStatus: null });
        continue;
      }
      calls += 1;
      const started = Date.now();
      let sent: Awaited<ReturnType<typeof sendPaidExchange>>;
      try {
        sent = await sendPaidExchange({ env, body, timeoutMs, fetchImpl, keyOnly: true });
      } catch {
        cumulativeUsd += bookCallCost(null, estimate);
        const failed = armCaseRow({ caseId: item.caseId, arm, providerStatus: 'transport_error' });
        rows.push({
          ...failed,
          durationMs: Date.now() - started,
          decisiveReason: null,
          expected: null,
          sealedCheckId: null,
          sealedStatus: null,
        });
        continue;
      }
      const durationMs = Date.now() - started;
      if (!sent.ok) {
        cumulativeUsd += bookCallCost(null, estimate);
        if (options.saveRawDir) saveRawResponse(options.saveRawDir, { caseId: item.caseId, arm, content: null, usage: null });
        const failed = armCaseRow({ caseId: item.caseId, arm, providerStatus: sent.reason });
        rows.push({ ...failed, durationMs, decisiveReason: null, expected: null, sealedCheckId: null, sealedStatus: null });
        continue;
      }
      if (options.saveRawDir) {
        saveRawResponse(options.saveRawDir, { caseId: item.caseId, arm, content: sent.content, usage: sent.usage });
      }
      cumulativeUsd += bookCallCost(sent.usageUsd, estimate);
      const evaluated = armCaseRow({
        caseId: item.caseId,
        arm,
        providerStatus: 'ok',
        documents: item.documents,
        content: sent.content,
      });
      const reason = evaluated.parserResult === 'ok' ? decisiveReason(item.documents, sent.content) : null;
      rows.push({
        ...evaluated,
        durationMs,
        decisiveReason: reason,
        expected: null,
        sealedCheckId: null,
        sealedStatus: null,
      });
    }
  }
  return {
    selector: 'trade-order-dev',
    head: options.head,
    maxCalls: plan.maxCalls,
    timeoutMs,
    calls_sent: calls,
    cumulativeCostUsd: cumulativeUsd,
    softCapNote: plan.costLimit.reason,
    rows: await attachSealed(rows),
  };
}

export type { ParserResult, ProviderStatus, TradeOrderPlan };
