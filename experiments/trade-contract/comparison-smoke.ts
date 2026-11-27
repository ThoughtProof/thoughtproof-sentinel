import { casesFor } from './comparison-cases.ts';
import type { Document } from './contract.ts';
import { createSpendLedger, maxCallCostUsd, PER_CASE_BUDGET_MS } from './comparison-budget.ts';
import { prepareModelContent } from './comparison-grounding.ts';
import { applySharedHost } from './comparison-grounding.ts';
import { paidPilotRefusalReason, sendPaidExchange, type PaidEnv } from './comparison-paid.ts';
import { schemaSmokePlan } from './comparison-plan.ts';
import type { ComparisonArm } from './comparison-prompt.ts';
import { buildArmRequest } from './comparison-run.ts';
import { ADAPTER_ID, decideCascade } from './adapter.ts';

const ARMS: readonly ComparisonArm[] = ['A', 'B'];

export interface SchemaSmokeReport {
  baseline: string;
  maxCalls: number;
  costCeilingUsd: number;
  devCases: number;
  calls: number;
  providerOrSchemaErrors: number;
  frozenValidatorRejections: number;
  substantiveUncertain: number;
  caseIds: string[];
}

/**
 * Dev cases only. Calling this cannot select a pilot case.
 */
export function schemaSmokeDocuments(): { caseId: string; documents: readonly Document[] }[] {
  return casesFor('dev').map(item => ({ caseId: item.caseId, documents: item.documents }));
}

/**
 * Schema pre-run. Sends only the dev selection. A mock fetch must be passed
 * in tests. Pilot documents are never passed to fetch.
 */
export async function runSchemaSmoke(env: PaidEnv, fetchImpl: typeof fetch): Promise<SchemaSmokeReport> {
  const reason = paidPilotRefusalReason(env);
  if (reason) throw new Error(`PAID_PILOT_REFUSED: ${reason}`);
  const plan = schemaSmokePlan();
  const cap = Number(env.GROUNDED_CRITIC_COST_CAP_USD);
  const budgetMs = env.GROUNDED_CRITIC_BUDGET_MS ? Number(env.GROUNDED_CRITIC_BUDGET_MS) : PER_CASE_BUDGET_MS;
  const ledger = createSpendLedger(cap);
  const report: SchemaSmokeReport = {
    baseline: plan.baseline,
    maxCalls: plan.maxCalls,
    costCeilingUsd: plan.costCeilingUsd,
    devCases: plan.caseIds.length,
    calls: 0,
    providerOrSchemaErrors: 0,
    frozenValidatorRejections: 0,
    substantiveUncertain: 0,
    caseIds: plan.caseIds,
  };
  for (const item of schemaSmokeDocuments()) {
    if (item.caseId.startsWith('pilot-')) throw new Error('SMOKE_TOUCHED_PILOT');
    for (const arm of ARMS) {
      const body = buildArmRequest(item.documents, arm);
      const ticket = ledger.tryReserve(maxCallCostUsd(JSON.stringify(body), body.max_completion_tokens));
      if (!ticket) continue;
      report.calls += 1;
      let sent: Awaited<ReturnType<typeof sendPaidExchange>>;
      try {
        sent = await sendPaidExchange({ env, body, timeoutMs: budgetMs, fetchImpl });
      } catch {
        ledger.keep(ticket);
        report.providerOrSchemaErrors += 1;
        continue;
      }
      if (!sent.ok) {
        ledger.keep(ticket);
        report.providerOrSchemaErrors += 1;
        continue;
      }
      if (sent.usageUsd === null) ledger.keep(ticket);
      else ledger.reconcile(ticket, sent.usageUsd);
      const prepared = prepareModelContent(sent.content, item.documents, 'primary');
      if (prepared.parseFailure) {
        report.providerOrSchemaErrors += 1;
        continue;
      }
      if (prepared.schemaFailure) {
        report.frozenValidatorRejections += 1;
        continue;
      }
      const frozen = decideCascade(
        item.documents,
        { ok: true, content: prepared.publicContent },
        null,
        { trustedAdapterIds: [ADAPTER_ID] },
      );
      const verdict = frozen.decision === 'ALLOW' || frozen.decision === 'BLOCK' || frozen.decision === 'UNCERTAIN'
        ? applySharedHost(frozen.decision, prepared.grounding, item.documents)
        : 'UNCERTAIN';
      if (verdict === 'UNCERTAIN') report.substantiveUncertain += 1;
    }
  }
  return report;
}
