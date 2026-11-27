import { ADAPTER_ID, buildAdapterRequest, decideCascade } from './adapter.ts';
import type { AdapterExchange, AdapterMessage } from './adapter.ts';
import type { Document } from './contract.ts';
import { PER_CASE_BUDGET_MS, exceedsCostCap, overBudget } from './comparison-budget.ts';
import { prepareModelContent } from './comparison-grounding.ts';
import { armSystemPrompt, type ComparisonArm } from './comparison-prompt.ts';
import { COMPARISON_SCHEMA, COMPARISON_SCHEMA_NAME } from './comparison-schema.ts';
import type { ArmOutcome, ArmRun, PublicVerdict } from './comparison-evaluate.ts';

const GATE_OPTIONS = { trustedAdapterIds: [ADAPTER_ID] as const };

export interface RecordedExchange {
  exchange: AdapterExchange;
  latencyMs: number;
  usageUsd?: number;
}

export interface ComparisonChatRequest {
  model: string;
  temperature: number;
  seed: number;
  max_completion_tokens: number;
  reasoning_effort: 'low' | 'none';
  response_format: {
    type: 'json_schema';
    json_schema: {
      name: string;
      strict: true;
      schema: unknown;
    };
  };
  messages: AdapterMessage[];
}

export function buildArmRequest(documents: readonly Document[], arm: ComparisonArm): ComparisonChatRequest {
  const request = buildAdapterRequest(documents, 'primary');
  return {
    model: request.model,
    temperature: request.temperature,
    seed: request.seed,
    max_completion_tokens: request.max_completion_tokens,
    reasoning_effort: request.reasoning_effort,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: COMPARISON_SCHEMA_NAME,
        strict: true,
        schema: COMPARISON_SCHEMA,
      },
    },
    messages: [
      { role: 'system', content: armSystemPrompt(arm) },
      request.messages[1],
    ],
  };
}

function verdictOf(decision: string): PublicVerdict | null {
  return decision === 'ALLOW' || decision === 'BLOCK' || decision === 'UNCERTAIN' ? decision : null;
}

function finish(
  arm: ComparisonArm,
  caseId: string,
  outcome: ArmOutcome,
  extras: Partial<ArmRun> = {},
): ArmRun {
  return {
    arm,
    caseId,
    outcome,
    publicVerdict: extras.publicVerdict ?? null,
    preGateVerdict: extras.preGateVerdict ?? null,
    latencyMs: extras.latencyMs ?? 0,
    schemaFailure: extras.schemaFailure ?? false,
    droppedIds: extras.droppedIds ?? [],
    technicalCode: extras.technicalCode ?? null,
  };
}

/**
 * One arm, one case. Secondary cascade is not consulted: a schema-valid
 * primary decision stands, including ALLOW. Both arms call this function
 * with the same budget, cost cap, and decideCascade options.
 */
export function runRecordedArm(input: {
  arm: ComparisonArm;
  caseId: string;
  documents: readonly Document[];
  recorded: RecordedExchange;
  costCapUsd: number;
  budgetMs?: number;
}): ArmRun {
  const budgetMs = input.budgetMs ?? PER_CASE_BUDGET_MS;
  const latencyMs = input.recorded.latencyMs;
  if (!input.recorded.exchange.ok && input.recorded.exchange.reason === 'timeout') {
    return finish(input.arm, input.caseId, 'timeout', { latencyMs, technicalCode: 'timeout' });
  }
  if (overBudget(latencyMs, budgetMs)) {
    return finish(input.arm, input.caseId, 'timeout', { latencyMs, technicalCode: 'budget' });
  }
  if (!input.recorded.exchange.ok) {
    return finish(input.arm, input.caseId, 'technical_error', {
      latencyMs,
      technicalCode: input.recorded.exchange.reason,
    });
  }
  if (input.recorded.usageUsd !== undefined && exceedsCostCap(input.recorded.usageUsd, input.costCapUsd)) {
    return finish(input.arm, input.caseId, 'technical_error', { latencyMs, technicalCode: 'cost_cap' });
  }
  const prepared = prepareModelContent(input.recorded.exchange.content, input.documents, input.arm);
  // Host gate: experiments/trade-contract/adapter.ts decideCascade, secondary null.
  const preGate = decideCascade(
    input.documents,
    { ok: true, content: prepared.preGateContent },
    null,
    GATE_OPTIONS,
  );
  const published = decideCascade(
    input.documents,
    { ok: true, content: prepared.publicContent },
    null,
    GATE_OPTIONS,
  );
  return finish(input.arm, input.caseId, 'verdict', {
    latencyMs,
    schemaFailure: prepared.schemaFailure,
    droppedIds: prepared.droppedIds,
    preGateVerdict: verdictOf(preGate.decision),
    publicVerdict: verdictOf(published.decision),
  });
}
