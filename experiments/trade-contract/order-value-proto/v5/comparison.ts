import { buildArmRequest } from '../../comparison-run.ts';
import type { Document } from '../../contract.ts';
import { BINDING_BUDGET_MS, simulatedExecution, type BindingDecision, type ProviderCall } from '../../direct-historical.ts';
import { historicalHoldoutRequest, type HoldoutCase } from '../../direct-holdout-plan.ts';
import { EXECUTABLE_MODE, composePublic, type MandatePacket, type OrderUnderReview } from './host.ts';

export interface Clock {
  now(): number;
}

export interface AuthorizedFacts {
  documents: Document[];
  mandate: MandatePacket;
  order: OrderUnderReview;
  world: Record<string, unknown>;
  action: Record<string, unknown>;
}

export interface PreflightTransport {
  send(request: { arm: 'sentinel_primary' | 'historical'; body: unknown }): Promise<{ content: string }>;
}

/**
 * Comparison entry. The mandate packet is already fixed. Both systems are
 * handed that same packet, order, and documents. The 45s budget is read
 * after host evaluation, at the executor decision.
 */
export async function runComparisonPreflight(input: {
  facts: AuthorizedFacts;
  clock: Clock;
  transport: PreflightTransport;
  beforeHost?: () => void;
}): Promise<{
  sentinelFacts: { documents: Document[]; mandate: MandatePacket; order: OrderUnderReview };
  historicalFacts: AuthorizedFacts;
  durationMs: number;
  budgetMs: number;
  publicVerdict: 'ALLOW' | 'BLOCK' | 'UNCERTAIN';
  timing: 'on_time' | 'late' | 'not_release';
  executed: boolean;
}> {
  const started = input.clock.now();
  const shared = {
    documents: input.facts.documents,
    mandate: input.facts.mandate,
    order: input.facts.order,
  };
  const row: HoldoutCase = {
    caseId: 'v5-preflight',
    documents: input.facts.documents,
    world: input.facts.world,
    action: input.facts.action,
  };
  const sentinelBody = buildArmRequest(shared.documents, 'B');
  const historicalBody = historicalHoldoutRequest(row);
  const primary = await input.transport.send({ arm: 'sentinel_primary', body: sentinelBody });
  await input.transport.send({ arm: 'historical', body: historicalBody });
  input.beforeHost?.();
  const composition = composePublic(shared.documents, primary.content, shared.mandate, shared.order, EXECUTABLE_MODE);
  const durationMs = input.clock.now() - started;
  const providerCalls: ProviderCall[] = [
    { stage: 'primary', model: 'grok-4.7', status: 'completed' },
    { stage: 'secondary', model: 'grok-4.3', status: 'not_sent' },
  ];
  const decision: BindingDecision = {
    arm: 'sentinel_b', systemVerdict: composition.publicVerdict, durationMs, providerCalls, reasons: ['order-value-proto/v5'],
  };
  const onTime = durationMs <= BINDING_BUDGET_MS;
  return {
    sentinelFacts: shared,
    historicalFacts: input.facts,
    durationMs,
    budgetMs: BINDING_BUDGET_MS,
    publicVerdict: composition.publicVerdict,
    timing: composition.publicVerdict !== 'ALLOW' ? 'not_release' : onTime ? 'on_time' : 'late',
    executed: simulatedExecution(decision).executed,
  };
}
