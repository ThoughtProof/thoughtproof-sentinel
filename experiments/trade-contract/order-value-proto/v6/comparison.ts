import { buildArmRequest } from '../../comparison-run.ts';
import type { Document } from '../../contract.ts';
import { strictBinding } from '../../direct-binding.ts';
import { gatewayStrong, simulatedExecution, type BindingDecision, type ProviderCall } from '../../direct-historical.ts';
import { historicalHoldoutRequest, type HoldoutCase } from '../../direct-holdout-plan.ts';
import { EXECUTABLE_MODE, composePublic, type MandatePacket, type OrderUnderReview, type PublicComposition } from './host.ts';

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

export interface SentRequest {
  arm: 'sentinel_primary' | 'historical';
  body: unknown;
}

export interface ArmReport {
  arm: 'sentinel' | 'historical';
  publicVerdict: string;
  numeric: string | null;
  grounding: string | null;
  durationMs: number;
  executed: boolean;
  criticCalls: number;
}

export interface ComparisonReport {
  sentinel: ArmReport;
  historical: ArmReport;
  sent: SentRequest[];
}

function sentinelExecutor(verdict: PublicComposition['publicVerdict'], durationMs: number): boolean {
  const calls: ProviderCall[] = [
    { stage: 'primary', model: 'grok-4.7', status: 'completed' },
    { stage: 'secondary', model: 'grok-4.3', status: 'not_sent' },
  ];
  const decision: BindingDecision = {
    arm: 'sentinel_b', systemVerdict: verdict, durationMs, providerCalls: calls, reasons: ['order-value-proto/v6'],
  };
  return simulatedExecution(decision).executed;
}

function parseCritic(content: string): { execute: unknown; verdict: unknown } | null {
  try {
    const parsed = JSON.parse(content) as { execute?: unknown; verdict?: unknown };
    if (!parsed || typeof parsed !== 'object') return null;
    return { execute: parsed.execute, verdict: parsed.verdict };
  } catch {
    return null;
  }
}

/**
 * Both complete paths. Each arm is timed from its own start through its own
 * host check to its executor decision. A gateway block does not send the critic.
 */
export async function runComparisonV6(input: {
  facts: AuthorizedFacts;
  clock: Clock;
  transport: { send(request: SentRequest): Promise<{ content: string }> };
}): Promise<ComparisonReport> {
  const sent: SentRequest[] = [];
  const row: HoldoutCase = {
    caseId: 'v6-comparison',
    documents: input.facts.documents,
    world: input.facts.world,
    action: input.facts.action,
  };
  const sentinelStart = input.clock.now();
  const sentinelRequest: SentRequest = { arm: 'sentinel_primary', body: buildArmRequest(input.facts.documents, 'B') };
  sent.push(sentinelRequest);
  const primary = await input.transport.send(sentinelRequest);
  const composition = composePublic(input.facts.documents, primary.content, input.facts.mandate, input.facts.order, EXECUTABLE_MODE);
  const sentinelDuration = input.clock.now() - sentinelStart;
  const sentinel: ArmReport = {
    arm: 'sentinel',
    publicVerdict: composition.publicVerdict,
    numeric: composition.numericAfter,
    grounding: composition.grounding.find(note => note.blocks)?.reason ?? (composition.grounding.length ? 'clear' : null),
    durationMs: sentinelDuration,
    executed: sentinelExecutor(composition.publicVerdict, sentinelDuration),
    criticCalls: 0,
  };

  const historicalStart = input.clock.now();
  const gate = gatewayStrong(input.facts.world, input.facts.action);
  if (!gate.execute) {
    return {
      sentinel,
      historical: {
        arm: 'historical', publicVerdict: gate.verdict, numeric: null, grounding: null,
        durationMs: input.clock.now() - historicalStart, executed: false, criticCalls: 0,
      },
      sent,
    };
  }
  const historicalRequest: SentRequest = { arm: 'historical', body: historicalHoldoutRequest(row) };
  sent.push(historicalRequest);
  const critic = await input.transport.send(historicalRequest);
  const raw = parseCritic(critic.content);
  const durationMs = input.clock.now() - historicalStart;
  const bound = strictBinding({ world: input.facts.world, action: input.facts.action, durationMs, raw });
  return {
    sentinel,
    historical: {
      arm: 'historical',
      publicVerdict: raw && typeof raw.verdict === 'string' ? raw.verdict : gate.verdict,
      numeric: null,
      grounding: null,
      durationMs,
      executed: bound.executed,
      criticCalls: 1,
    },
    sent,
  };
}
