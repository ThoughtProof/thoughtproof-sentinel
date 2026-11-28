import { casesFor } from './comparison-cases.ts';
import type { Document } from './contract.ts';
import { createSpendLedger, maxCallCostUsd, PER_CASE_BUDGET_MS } from './comparison-budget.ts';
import { paidPilotRefusalReason, sendPaidExchange, type PaidEnv } from './comparison-paid.ts';
import { schemaSmokePlan } from './comparison-plan.ts';
import type { ComparisonArm } from './comparison-prompt.ts';
import { buildArmRequest } from './comparison-run.ts';
import { armCaseRow, dev06AllowBlocker, type ArmCaseRow } from './comparison-report.ts';
import { saveRawResponse } from './comparison-raw.ts';

const ARMS: readonly ComparisonArm[] = ['A', 'B'];

/** Constraints for `--schema-smoke --paid`. Retries stay zero. */
export const SCHEMA_SMOKE_PAID = {
  maxCalls: 12,
  timeoutMs: 45_000,
  retries: 0,
  budgetUsd: 1,
} as const;

/**
 * A single grok-4.7 call can cost more than its visible-token estimate.
 * The cap is soft: further calls stop, but the call already sent is not undone.
 */
export const SCHEMA_SMOKE_SOFT_CAP_NOTE =
  'A single call may exceed the 1.00 USD cap. max_completion_tokens does not bound grok-4.7 reasoning tokens. '
  + 'Further calls are not sent once cumulative actual cost plus the next pre-send estimate would exceed 1.00 USD.';

/** True when this call must not be sent. Equality with the cap is still allowed. */
export function nextCallExceedsSoftCap(cumulativeUsd: number, nextEstimateUsd: number, capUsd: number = SCHEMA_SMOKE_PAID.budgetUsd): boolean {
  return cumulativeUsd + nextEstimateUsd > capUsd;
}

/**
 * Missing ticks book the full pre-send estimate. A measured cost, including zero, is used as reported.
 * https://docs.x.ai/developers/cost-tracking — ticks / 1e10.
 */
export function bookCallCost(usageUsd: number | null, preSendEstimateUsd: number): number {
  if (usageUsd === null) return preSendEstimateUsd;
  return usageUsd;
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
  calls_sent: number;
  cumulativeCostUsd: number;
  softCapNote: string | null;
}

/**
 * Dev cases only. Calling this cannot select a pilot case.
 */
export function schemaSmokeDocuments(): { caseId: string; documents: readonly Document[] }[] {
  return casesFor('dev').map(item => ({ caseId: item.caseId, documents: item.documents }));
}

export interface SchemaSmokeOptions {
  /** Soft cap. Before each call, cumulative actual plus the next estimate must not exceed this. */
  softCapUsd?: number;
  timeoutMs?: number;
  maxCalls?: number;
  /** Read the key only. Do not require the other paid-env flags. */
  keyOnly?: boolean;
  /** When set, write model content and usage only. Headers and the key are not written. */
  saveRawDir?: string;
}

/**
 * Schema pre-run. Sends only the dev selection. A mock fetch must be passed
 * in tests. Pilot documents are never passed to fetch. There is no retry loop.
 */
export async function runSchemaSmoke(
  env: PaidEnv,
  fetchImpl: typeof fetch,
  options: SchemaSmokeOptions = {},
): Promise<SchemaSmokeReport> {
  if (options.keyOnly) {
    if (!env.XAI_API_KEY) throw new Error('PAID_PILOT_REFUSED: XAI_API_KEY is not set');
  } else {
    const reason = paidPilotRefusalReason(env);
    if (reason) throw new Error(`PAID_PILOT_REFUSED: ${reason}`);
  }
  const plan = schemaSmokePlan();
  const cap = options.softCapUsd ?? Number(env.GROUNDED_CRITIC_COST_CAP_USD);
  const budgetMs = options.timeoutMs ?? (env.GROUNDED_CRITIC_BUDGET_MS ? Number(env.GROUNDED_CRITIC_BUDGET_MS) : PER_CASE_BUDGET_MS);
  const ledger = createSpendLedger(cap);
  const softCap = options.softCapUsd !== undefined;
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
    calls_sent: 0,
    cumulativeCostUsd: 0,
    softCapNote: softCap ? SCHEMA_SMOKE_SOFT_CAP_NOTE : null,
  };
  const maxCalls = Math.min(plan.maxCalls, options.maxCalls ?? SCHEMA_SMOKE_PAID.maxCalls);
  let cumulativeUsd = 0;
  let stopForCap = false;
  for (const item of schemaSmokeDocuments()) {
    if (report.calls >= maxCalls || stopForCap) break;
    if (item.caseId.startsWith('pilot-')) throw new Error('SMOKE_TOUCHED_PILOT');
    for (const arm of ARMS) {
      if (report.calls >= maxCalls || stopForCap) break;
      const body = buildArmRequest(item.documents, arm);
      const estimate = maxCallCostUsd(JSON.stringify(body), body.max_completion_tokens);
      if (softCap && nextCallExceedsSoftCap(cumulativeUsd, estimate, cap)) {
        stopForCap = true;
        report.rows.push(armCaseRow({ caseId: item.caseId, arm, providerStatus: 'not_sent' }));
        continue;
      }
      const ticket = softCap ? null : ledger.tryReserve(estimate);
      if (!softCap && !ticket) {
        report.rows.push(armCaseRow({ caseId: item.caseId, arm, providerStatus: 'not_sent' }));
        continue;
      }
      report.calls += 1;
      let sent: Awaited<ReturnType<typeof sendPaidExchange>>;
      try {
        sent = await sendPaidExchange({ env, body, timeoutMs: budgetMs, fetchImpl, keyOnly: options.keyOnly === true });
      } catch {
        const booked = bookCallCost(null, estimate);
        cumulativeUsd += booked;
        if (ticket) ledger.keep(ticket);
        const row = armCaseRow({ caseId: item.caseId, arm, providerStatus: 'transport_error' });
        report.rows.push(row);
        report.providerOrSchemaErrors += 1;
        continue;
      }
      if (!sent.ok) {
        const booked = bookCallCost(null, estimate);
        cumulativeUsd += booked;
        if (ticket) ledger.keep(ticket);
        if (options.saveRawDir) {
          saveRawResponse(options.saveRawDir, { caseId: item.caseId, arm, content: null, usage: null });
        }
        const row = armCaseRow({ caseId: item.caseId, arm, providerStatus: sent.reason });
        report.rows.push(row);
        report.providerOrSchemaErrors += 1;
        continue;
      }
      if (options.saveRawDir) {
        saveRawResponse(options.saveRawDir, {
          caseId: item.caseId,
          arm,
          content: sent.content,
          usage: sent.usage,
        });
      }
      const booked = bookCallCost(sent.usageUsd, estimate);
      cumulativeUsd += booked;
      if (ticket) {
        if (sent.usageUsd === null) ledger.keep(ticket);
        else ledger.reconcile(ticket, sent.usageUsd);
      }
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
  report.calls_sent = report.calls;
  report.cumulativeCostUsd = cumulativeUsd;
  return report;
}
