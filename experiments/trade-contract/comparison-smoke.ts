import { casesFor } from './comparison-cases.ts';
import type { Document } from './contract.ts';
import { createSpendLedger, maxCallCostUsd, PER_CASE_BUDGET_MS } from './comparison-budget.ts';
import { paidPilotRefusalReason, sendPaidExchange, type PaidEnv } from './comparison-paid.ts';
import { schemaSmokePlan } from './comparison-plan.ts';
import type { ComparisonArm } from './comparison-prompt.ts';
import { buildArmRequest } from './comparison-run.ts';
import { armCaseRow, dev06AllowBlocker, type ArmCaseRow } from './comparison-report.ts';

const ARMS: readonly ComparisonArm[] = ['A', 'B'];

/** Constraints for `--schema-smoke --paid`. Retries stay zero. */
export const SCHEMA_SMOKE_PAID = {
  maxCalls: 12,
  timeoutMs: 45_000,
  retries: 0,
  budgetUsd: 1,
} as const;

/**
 * grok-4.7 bills reasoning tokens outside `max_completion_tokens`, and
 * reasoning cannot be turned off. Lowering the visible cap does not bound
 * the bill. https://docs.x.ai/developers/model-capabilities/text/best-practices
 * and the chat-completions reference: the cap applies only to visible output.
 */
export function schemaSmokeUsdIsPreSendUpperBound(): false {
  return false;
}

export function schemaSmokePaidRefusal(): string {
  return 'Schema smoke was not sent. 1 USD is not guaranteed before send: '
    + 'max_completion_tokens does not bound grok-4.7 reasoning tokens '
    + '(https://docs.x.ai/developers/model-capabilities/text/best-practices; '
    + 'chat completions: the cap applies only to visible output). '
    + `reasoning_effort low still reasons, and there is no published token ceiling. `
    + `${SCHEMA_SMOKE_PAID.maxCalls} calls times a visible-token estimate is not a worst case. `
    + 'No request was sent.';
}

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
  rows: ArmCaseRow[];
  dev06: { bothUncertain: boolean; firstAllowBlocker: string | null };
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
    rows: [],
    dev06: { bothUncertain: false, firstAllowBlocker: null },
  };
  const maxCalls = Math.min(plan.maxCalls, SCHEMA_SMOKE_PAID.maxCalls);
  for (const item of schemaSmokeDocuments()) {
    if (report.calls >= maxCalls) break;
    if (item.caseId.startsWith('pilot-')) throw new Error('SMOKE_TOUCHED_PILOT');
    for (const arm of ARMS) {
      if (report.calls >= maxCalls) break;
      const body = buildArmRequest(item.documents, arm);
      const ticket = ledger.tryReserve(maxCallCostUsd(JSON.stringify(body), body.max_completion_tokens));
      if (!ticket) {
        report.rows.push(armCaseRow({ caseId: item.caseId, arm, providerStatus: 'not_sent' }));
        continue;
      }
      report.calls += 1;
      let sent: Awaited<ReturnType<typeof sendPaidExchange>>;
      try {
        sent = await sendPaidExchange({ env, body, timeoutMs: budgetMs, fetchImpl });
      } catch {
        ledger.keep(ticket);
        const row = armCaseRow({ caseId: item.caseId, arm, providerStatus: 'transport_error' });
        report.rows.push(row);
        report.providerOrSchemaErrors += 1;
        continue;
      }
      if (!sent.ok) {
        ledger.keep(ticket);
        const row = armCaseRow({ caseId: item.caseId, arm, providerStatus: sent.reason });
        report.rows.push(row);
        report.providerOrSchemaErrors += 1;
        continue;
      }
      if (sent.usageUsd === null) ledger.keep(ticket);
      else ledger.reconcile(ticket, sent.usageUsd);
      const row = armCaseRow({
        caseId: item.caseId,
        arm,
        providerStatus: 'ok',
        documents: item.documents,
        content: sent.content,
      });
      report.rows.push(row);
      if (row.countsAs === 'provider_or_schema') report.providerOrSchemaErrors += 1;
      else if (row.countsAs === 'validator_rejection') report.frozenValidatorRejections += 1;
      else if (row.countsAs === 'substantive_uncertain') report.substantiveUncertain += 1;
    }
  }
  report.dev06 = dev06AllowBlocker(report.rows);
  return report;
}
