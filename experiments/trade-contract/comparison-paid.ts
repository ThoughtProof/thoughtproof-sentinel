import { XAI_CHAT_COMPLETIONS_URL } from './messages.ts';
import { MODEL_CONFIG } from './model-config.ts';
import { casesFor } from './comparison-cases.ts';
import { PER_CASE_BUDGET_MS, exceedsCostCap } from './comparison-budget.ts';
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
  usageUsd: number;
} | {
  ok: false;
  reason: 'timeout' | 'transport_error' | 'http_error' | 'empty';
}

function estimateUsd(promptTokens: number, completionTokens: number): number {
  const price = MODEL_CONFIG.primary.pricing.shortContext;
  return (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
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
}): Promise<PaidSendResult> {
  if (paidPilotRefusalReason(input.env) !== null) return { ok: false, reason: 'transport_error' };
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
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') return { ok: false, reason: 'empty' };
    return {
      ok: true,
      content,
      usageUsd: estimateUsd(payload.usage?.prompt_tokens ?? 0, payload.usage?.completion_tokens ?? 0),
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'transport_error' };
  }
}

const ARMS: readonly ComparisonArm[] = ['A', 'B'];

/** Later paid pilot. Tests must not call this with a live fetch. */
export async function runPaidPilot(env: PaidEnv, fetchImpl?: typeof fetch): Promise<ArmRun[]> {
  const reason = paidPilotRefusalReason(env);
  if (reason) throw new Error(`PAID_PILOT_REFUSED: ${reason}`);
  const cap = Number(env.GROUNDED_CRITIC_COST_CAP_USD);
  const budgetMs = env.GROUNDED_CRITIC_BUDGET_MS ? Number(env.GROUNDED_CRITIC_BUDGET_MS) : PER_CASE_BUDGET_MS;
  let spent = 0;
  const runs: ArmRun[] = [];
  for (const item of casesFor('pilot')) {
    for (const arm of ARMS) {
      if (exceedsCostCap(spent, cap)) {
        runs.push({
          arm,
          caseId: item.caseId,
          outcome: 'technical_error',
          publicVerdict: null,
          preGateVerdict: null,
          latencyMs: 0,
          schemaFailure: false,
          droppedIds: [],
          technicalCode: 'cost_cap',
        });
        continue;
      }
      const started = Date.now();
      const sent = await sendPaidExchange({
        env,
        body: buildArmRequest(item.documents, arm),
        timeoutMs: budgetMs,
        fetchImpl,
      });
      const latencyMs = Date.now() - started;
      if (sent.ok) spent += sent.usageUsd;
      runs.push(runRecordedArm({
        arm,
        caseId: item.caseId,
        documents: item.documents,
        costCapUsd: cap,
        budgetMs,
        recorded: sent.ok
          ? { exchange: { ok: true, content: sent.content }, latencyMs, usageUsd: sent.usageUsd }
          : { exchange: { ok: false, reason: sent.reason }, latencyMs },
      }));
    }
  }
  return runs;
}
