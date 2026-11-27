import { XAI_CHAT_COMPLETIONS_URL } from './messages.ts';
import { casesFor } from './comparison-cases.ts';
import { PER_CASE_BUDGET_MS, createSpendLedger, maxCallCostUsd } from './comparison-budget.ts';
import { buildArmRequest, runRecordedArm } from './comparison-run.ts';
import type { ArmRun } from './comparison-evaluate.ts';
import type { ComparisonArm } from './comparison-prompt.ts';

export interface PaidEnv {
  GROUNDED_CRITIC_ALLOW_PAID?: string;
  GROUNDED_CRITIC_COST_CAP_USD?: string;
  GROUNDED_CRITIC_BUDGET_MS?: string;
  XAI_API_KEY?: string;
}

/**
 * Returns a reason when a paid call must not be sent. The reason never
 * includes secret values.
 */
export function paidPilotRefusalReason(env: PaidEnv): string | null {
  if (env.GROUNDED_CRITIC_ALLOW_PAID !== '1') return 'GROUNDED_CRITIC_ALLOW_PAID is not 1';
  if (!env.XAI_API_KEY) return 'XAI_API_KEY is not set';
  const cap = Number(env.GROUNDED_CRITIC_COST_CAP_USD);
  if (!Number.isFinite(cap) || cap <= 0) return 'GROUNDED_CRITIC_COST_CAP_USD is not a positive number';
  return null;
}

export type PaidSendResult = {
  ok: true;
  content: string;
  /** Null when the provider omits usage. That is not zero. */
  usageUsd: number | null;
} | {
  ok: false;
  reason: 'timeout' | 'transport_error' | 'http_error' | 'empty';
}

/**
 * https://docs.x.ai/developers/cost-tracking
 * 1 USD = 10^10 ticks. `usage.cost_in_usd_ticks / XAI_USD_TICKS` is the billed amount.
 */
export const XAI_USD_TICKS = 10_000_000_000;

export function usdFromXaiTicks(ticks: number): number | null {
  if (!Number.isInteger(ticks) || ticks < 0) return null;
  return ticks / XAI_USD_TICKS;
}

/**
 * Sends one chat-completions request. Callers must already have passed
 * paidPilotRefusalReason. Errors are reduced to a reason code so a thrown
 * client message cannot echo the request or the key.
 */
export async function sendPaidExchange(input: {
  env: PaidEnv;
  body: unknown;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** When set, the only credential read is env.XAI_API_KEY. It is not written to logs. */
  keyOnly?: boolean;
}): Promise<PaidSendResult> {
  if (input.keyOnly) {
    if (!input.env.XAI_API_KEY) return { ok: false, reason: 'transport_error' };
  } else if (paidPilotRefusalReason(input.env) !== null) return { ok: false, reason: 'transport_error' };
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(XAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.env.XAI_API_KEY}`,
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    if (!response.ok) return { ok: false, reason: 'http_error' };
    const payload = await response.json() as {
      choices?: { message?: { content?: string } }[];
      usage?: { cost_in_usd_ticks?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') return { ok: false, reason: 'empty' };
    const ticks = payload.usage?.cost_in_usd_ticks;
    return {
      ok: true,
      content,
      usageUsd: typeof ticks === 'number' ? usdFromXaiTicks(ticks) : null,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'transport_error' };
  }
}

const ARMS: readonly ComparisonArm[] = ['A', 'B'];

function costCapRow(arm: ComparisonArm, caseId: string): ArmRun {
  return {
    arm,
    caseId,
    outcome: 'technical_error',
    publicVerdict: null,
    preGateVerdict: null,
    latencyMs: 0,
    schemaFailure: false,
    droppedIds: [],
    technicalCode: 'cost_cap',
  };
}

/**
 * Later paid pilot. Reserves the conservative max before each send.
 * Tests must pass a mock fetch. This function only walks pilot cases.
 */
export async function runPaidPilot(env: PaidEnv, fetchImpl?: typeof fetch): Promise<ArmRun[]> {
  const reason = paidPilotRefusalReason(env);
  if (reason) throw new Error(`PAID_PILOT_REFUSED: ${reason}`);
  const cap = Number(env.GROUNDED_CRITIC_COST_CAP_USD);
  const budgetMs = env.GROUNDED_CRITIC_BUDGET_MS ? Number(env.GROUNDED_CRITIC_BUDGET_MS) : PER_CASE_BUDGET_MS;
  const ledger = createSpendLedger(cap);
  const runs: ArmRun[] = [];
  for (const item of casesFor('pilot')) {
    for (const arm of ARMS) {
      const body = buildArmRequest(item.documents, arm);
      const ticket = ledger.tryReserve(maxCallCostUsd(JSON.stringify(body), body.max_completion_tokens));
      if (!ticket) {
        runs.push(costCapRow(arm, item.caseId));
        continue;
      }
      const started = Date.now();
      let sent: Awaited<ReturnType<typeof sendPaidExchange>>;
      try {
        sent = await sendPaidExchange({ env, body, timeoutMs: budgetMs, fetchImpl });
      } catch {
        ledger.keep(ticket);
        runs.push({
          ...costCapRow(arm, item.caseId),
          outcome: 'technical_error',
          technicalCode: 'transport_error',
          latencyMs: Date.now() - started,
        });
        continue;
      }
      const latencyMs = Date.now() - started;
      if (!sent.ok || sent.usageUsd === null) ledger.keep(ticket);
      else ledger.reconcile(ticket, sent.usageUsd);
      runs.push(runRecordedArm({
        arm,
        caseId: item.caseId,
        documents: item.documents,
        costCapUsd: cap,
        budgetMs,
        recorded: sent.ok
          ? { exchange: { ok: true, content: sent.content }, latencyMs, usageUsd: sent.usageUsd ?? undefined }
          : { exchange: { ok: false, reason: sent.reason }, latencyMs },
      }));
    }
  }
  return runs;
}
