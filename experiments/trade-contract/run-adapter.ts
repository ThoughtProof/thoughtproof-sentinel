import { buildArmRequest } from './comparison-run.ts';
import { prepareModelContent } from './comparison-grounding.ts';
import { strictBinding } from './direct-binding.ts';
import { createComparisonBudget, estimateNextCallUsd, SHARED_BUDGET_USD } from './direct-budget.ts';
import { gatewayStrong } from './direct-historical.ts';
import { historicalHoldoutRequest, type HoldoutCase } from './direct-holdout-plan.ts';
import { composePublic, EXECUTABLE_MODE, type MandatePacket, type OrderUnderReview } from './order-value-proto/v6/host.ts';

export type RecordedStatus = 'public_verdict' | 'protocol_error' | 'timeout' | 'gateway_block' | 'not_run_budget';

export interface RunAdapterTransport {
  send(request: {
    arm: 'sentinel_primary' | 'historical';
    body: unknown;
    timeoutMs: number;
  }): Promise<
    | { ok: true; content: string; usageUsd: number | null }
    | { ok: false; reason: 'timeout' | 'transport_error' }
  >;
}

export interface ArmRun {
  arm: 'sentinel' | 'historical';
  recorded: RecordedStatus;
  /** Null when the arm did not publish ALLOW, BLOCK, or UNCERTAIN. */
  publicVerdict: 'ALLOW' | 'BLOCK' | 'UNCERTAIN' | null;
  protocolError: 'protocol_error' | null;
  executed: boolean;
  durationMs: number;
  criticCalls: number;
}

export interface RunAdapterReport {
  sentinel: ArmRun;
  historical: ArmRun;
  budgetClosed: boolean;
}

const SYSTEM_MS = 45_000;

function blank(arm: ArmRun['arm'], recorded: RecordedStatus, durationMs: number, criticCalls = 0): ArmRun {
  return {
    arm, recorded, publicVerdict: null, protocolError: recorded === 'protocol_error' ? 'protocol_error' : null,
    executed: false, durationMs, criticCalls,
  };
}

function parseCritic(content: string): { execute: unknown; verdict: unknown } | null {
  try {
    const parsed = JSON.parse(content) as { execute?: unknown; verdict?: unknown };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return { execute: parsed.execute, verdict: parsed.verdict };
  } catch {
    return null;
  }
}

/**
 * Run adapter over the frozen v6 host. A timeout or an invalid payload is
 * not a public verdict. The other arm still runs when the shared budget allows.
 */
export async function runAdapter(input: {
  documents: HoldoutCase['documents'];
  mandate: MandatePacket;
  order: OrderUnderReview;
  world: Record<string, unknown>;
  action: Record<string, unknown>;
  transport: RunAdapterTransport;
  budget?: ReturnType<typeof createComparisonBudget>;
}): Promise<RunAdapterReport> {
  const budget = input.budget ?? createComparisonBudget(SHARED_BUDGET_USD);
  const row: HoldoutCase = {
    caseId: 'run-adapter',
    documents: input.documents,
    world: input.world,
    action: input.action,
  };
  const sentinel = await runSentinel();
  const historical = await runHistorical();
  return { sentinel, historical, budgetClosed: budget.snapshot().closed };

  async function send(arm: 'sentinel_primary' | 'historical', body: unknown, started: number) {
    const estimate = estimateNextCallUsd(arm, JSON.stringify(body));
    if (budget.snapshot().closed || budget.wouldExceed(estimate)) {
      budget.latch();
      return { kind: 'budget' as const, durationMs: Date.now() - started };
    }
    const ticket = budget.tryReserve(estimate);
    if (!ticket) {
      budget.latch();
      return { kind: 'budget' as const, durationMs: Date.now() - started };
    }
    try {
      const sent = await input.transport.send({ arm, body, timeoutMs: SYSTEM_MS });
      if (!sent.ok) {
        budget.keep(ticket);
        return { kind: sent.reason, durationMs: Date.now() - started };
      }
      if (sent.usageUsd === null) budget.keep(ticket);
      else budget.commitMeasured(ticket, sent.usageUsd);
      return { kind: 'result' as const, content: sent.content, durationMs: Date.now() - started };
    } catch {
      budget.keep(ticket);
      return { kind: 'transport_error' as const, durationMs: Date.now() - started };
    }
  }

  async function runSentinel(): Promise<ArmRun> {
    const started = Date.now();
    const sent = await send('sentinel_primary', buildArmRequest(input.documents, 'B'), started);
    const durationMs = Date.now() - started;
    if (sent.kind === 'budget') return blank('sentinel', 'not_run_budget', durationMs);
    if (sent.kind === 'timeout') return blank('sentinel', 'timeout', durationMs);
    if (sent.kind !== 'result') return blank('sentinel', 'protocol_error', durationMs);
    const prepared = prepareModelContent(sent.content, input.documents, 'primary');
    if (prepared.parseFailure || prepared.schemaFailure) return blank('sentinel', 'protocol_error', durationMs);
    const composition = composePublic(input.documents, prepared.publicContent, input.mandate, input.order, EXECUTABLE_MODE);
    return {
      arm: 'sentinel',
      recorded: 'public_verdict',
      publicVerdict: composition.publicVerdict,
      protocolError: null,
      executed: composition.publicVerdict === 'ALLOW' && durationMs <= SYSTEM_MS,
      durationMs,
      criticCalls: 0,
    };
  }

  async function runHistorical(): Promise<ArmRun> {
    const started = Date.now();
    const gate = gatewayStrong(input.world, input.action);
    if (!gate.execute) {
      const verdict = gate.verdict === 'ALLOW' || gate.verdict === 'BLOCK' || gate.verdict === 'UNCERTAIN' ? gate.verdict : null;
      return {
        arm: 'historical', recorded: 'gateway_block', publicVerdict: verdict, protocolError: null,
        executed: false, durationMs: Date.now() - started, criticCalls: 0,
      };
    }
    const sent = await send('historical', historicalHoldoutRequest(row), started);
    const durationMs = Date.now() - started;
    if (sent.kind === 'budget') return blank('historical', 'not_run_budget', durationMs);
    if (sent.kind === 'timeout') return blank('historical', 'timeout', durationMs, 1);
    if (sent.kind !== 'result') return blank('historical', 'protocol_error', durationMs, 1);
    const raw = parseCritic(sent.content);
    const bound = strictBinding({ world: input.world, action: input.action, durationMs, raw });
    if (bound.protocolError) return blank('historical', 'protocol_error', durationMs, 1);
    const verdict = raw && (raw.verdict === 'ALLOW' || raw.verdict === 'BLOCK' || raw.verdict === 'UNCERTAIN') ? raw.verdict : null;
    if (!verdict) return blank('historical', 'protocol_error', durationMs, 1);
    return {
      arm: 'historical',
      recorded: 'public_verdict',
      publicVerdict: verdict,
      protocolError: null,
      executed: bound.executed,
      durationMs,
      criticCalls: 1,
    };
  }
}
