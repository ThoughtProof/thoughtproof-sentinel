import { ADAPTER_ID, decideCascade, parseOutput, type AdapterExchange } from './adapter.ts';
import { applySharedHost, prepareModelContent } from './comparison-grounding.ts';
import { buildAdapterRequest } from './messages.ts';
import { buildArmRequest } from './comparison-run.ts';
import { MODEL_CONFIG } from './model-config.ts';
import { strictBinding } from './direct-binding.ts';
import {
  SHARED_BUDGET_USD, createComparisonBudget, estimateNextCallUsd,
  type BudgetArm, type CallRunStatus, type PairStatus,
} from './direct-budget.ts';
import { gatewayStrong } from './direct-historical.ts';
import { historicalHoldoutRequest, type HoldoutCase } from './direct-holdout-plan.ts';
import { sentinelStage } from './direct-sentinel-stage.ts';

export const DIRECT_MAX_CALLS = 18;
export const DIRECT_RETRIES = 0 as const;
export const DIRECT_SYSTEM_MS = 45_000;

export interface DirectTransport {
  send(request: {
    caseId: string;
    arm: BudgetArm;
    body: unknown;
    timeoutMs: number;
    retries: 0;
  }): Promise<
    | { ok: true; content: string; usageUsd: number | null }
    | { ok: false; reason: 'timeout' | 'http_error' | 'empty' | 'transport_error' }
  >;
}

export interface SystemOutcome {
  caseId: string;
  system: 'sentinel' | 'historical';
  status: CallRunStatus;
  verdict: string | null;
  executed: boolean;
  durationMs: number;
  secondary_called: boolean;
  public_verdict_stage: 'primary' | 'secondary' | 'none';
  protocolError: 'protocol_error' | null;
}

export interface DirectRunReport {
  ledger: ReturnType<typeof createComparisonBudget>;
  outcomes: SystemOutcome[];
  calls: number;
  pairs: { caseId: string; status: PairStatus }[];
}

type Sent =
  | { kind: 'not_run_budget' }
  | { kind: 'capped' }
  | { kind: 'timeout'; durationMs: number }
  | { kind: 'http'; reason: 'http_error' | 'empty' | 'transport_error'; durationMs: number }
  | { kind: 'result'; content: string; durationMs: number };

const FAILURES = new Set<string>(MODEL_CONFIG.cascade.when);

function verdictOf(decision: string): 'ALLOW' | 'BLOCK' | 'UNCERTAIN' {
  if (decision === 'ALLOW' || decision === 'BLOCK' || decision === 'UNCERTAIN') return decision;
  return 'UNCERTAIN';
}

export async function runDirectComparison(input: {
  cases: readonly HoldoutCase[];
  transport: DirectTransport;
  budget?: ReturnType<typeof createComparisonBudget>;
  maxCalls?: number;
  systemMs?: number;
}): Promise<DirectRunReport> {
  const ledger = input.budget ?? createComparisonBudget(SHARED_BUDGET_USD);
  const maxCalls = input.maxCalls ?? DIRECT_MAX_CALLS;
  const systemMs = input.systemMs ?? DIRECT_SYSTEM_MS;
  let calls = 0;
  const outcomes: SystemOutcome[] = [];

  async function reserveAndSend(caseId: string, arm: BudgetArm, body: unknown, timeoutMs: number): Promise<Sent> {
    if (calls >= maxCalls) return { kind: 'capped' };
    if (ledger.snapshot().closed) return { kind: 'not_run_budget' };
    const estimate = estimateNextCallUsd(arm, JSON.stringify(body));
    if (ledger.wouldExceed(estimate)) {
      ledger.latch();
      return { kind: 'not_run_budget' };
    }
    const ticket = ledger.tryReserve(estimate);
    if (!ticket) {
      ledger.latch();
      return { kind: 'not_run_budget' };
    }
    const started = Date.now();
    let sent: Awaited<ReturnType<DirectTransport['send']>>;
    try {
      sent = await input.transport.send({ caseId, arm, body, timeoutMs, retries: DIRECT_RETRIES });
    } catch {
      calls += 1;
      ledger.keep(ticket);
      return { kind: 'http', reason: 'transport_error', durationMs: Date.now() - started };
    }
    calls += 1;
    const durationMs = Date.now() - started;
    if (!sent.ok) {
      ledger.keep(ticket);
      return sent.reason === 'timeout'
        ? { kind: 'timeout', durationMs }
        : { kind: 'http', reason: sent.reason, durationMs };
    }
    if (sent.usageUsd === null) ledger.keep(ticket);
    else ledger.commitMeasured(ticket, sent.usageUsd);
    return { kind: 'result', content: sent.content, durationMs };
  }

  for (const row of input.cases) {
    if (ledger.snapshot().closed) {
      outcomes.push(stopped(row.caseId, 'sentinel'), stopped(row.caseId, 'historical'));
      continue;
    }
    outcomes.push(await runSentinel(row));
    if (ledger.snapshot().closed) {
      outcomes.push(stopped(row.caseId, 'historical'));
      continue;
    }
    outcomes.push(await runHistorical(row));
  }

  return {
    ledger,
    outcomes,
    calls,
    pairs: input.cases.map(row => ({ caseId: row.caseId, status: pairFor(outcomes, row.caseId) })),
  };

  async function runSentinel(row: HoldoutCase): Promise<SystemOutcome> {
    const started = Date.now();
    const remain = () => systemMs - (Date.now() - started);
    const primary = await reserveAndSend(row.caseId, 'sentinel_primary', buildArmRequest(row.documents, 'B'), Math.max(1, remain()));
    if (primary.kind === 'not_run_budget') return stopped(row.caseId, 'sentinel');
    if (primary.kind === 'capped') return technical(row.caseId, 'sentinel', 'error', Date.now() - started);
    if (primary.kind === 'timeout') return technical(row.caseId, 'sentinel', 'timeout', Date.now() - started);
    let secondaryExchange: AdapterExchange | null = null;
    let secondaryCalled = false;
    const parsed = primary.kind === 'result' ? parseOutput(primary.content) : { failure: primary.reason };
    const needsSecondary = 'failure' in parsed && FAILURES.has(parsed.failure);
    if (needsSecondary && remain() > 0) {
      const secondary = await reserveAndSend(
        row.caseId, 'sentinel_secondary', buildAdapterRequest(row.documents, 'secondary'), Math.max(1, remain()),
      );
      if (secondary.kind === 'not_run_budget') return stopped(row.caseId, 'sentinel');
      if (secondary.kind === 'timeout') return technical(row.caseId, 'sentinel', 'timeout', Date.now() - started);
      if (secondary.kind === 'result') {
        secondaryCalled = true;
        secondaryExchange = { ok: true, content: secondary.content };
      }
    }
    const primaryExchange: AdapterExchange = primary.kind === 'result'
      ? { ok: true, content: primary.content }
      : { ok: false, reason: primary.reason };
    const decided = decideCascade(row.documents, primaryExchange, secondaryExchange, { trustedAdapterIds: [ADAPTER_ID] });
    if (secondaryCalled && decided.decision === 'ALLOW') throw new Error('SECONDARY_PUBLISHED_ALLOW');
    const source = secondaryExchange?.ok ? secondaryExchange.content : primary.kind === 'result' ? primary.content : '';
    const prepared = source ? prepareModelContent(source, row.documents, 'primary') : null;
    const verdict = secondaryCalled || !prepared
      ? verdictOf(decided.decision)
      : applySharedHost(verdictOf(decided.decision), prepared.grounding, row.documents);
    const durationMs = Date.now() - started;
    const stage = sentinelStage({ documents: row.documents, primary: primaryExchange, secondary: secondaryExchange });
    return {
      caseId: row.caseId,
      system: 'sentinel',
      status: 'result',
      verdict,
      executed: verdict === 'ALLOW' && durationMs <= systemMs,
      durationMs,
      secondary_called: secondaryCalled,
      public_verdict_stage: secondaryCalled ? 'secondary' : stage.public_verdict_stage,
      protocolError: null,
    };
  }

  async function runHistorical(row: HoldoutCase): Promise<SystemOutcome> {
    const started = Date.now();
    const gate = gatewayStrong(row.world, row.action);
    if (!gate.execute) {
      return {
        caseId: row.caseId, system: 'historical', status: 'result', verdict: gate.verdict,
        executed: false, durationMs: Date.now() - started, secondary_called: false,
        public_verdict_stage: 'none', protocolError: null,
      };
    }
    const sent = await reserveAndSend(
      row.caseId, 'historical', historicalHoldoutRequest(row), Math.max(1, systemMs - (Date.now() - started)),
    );
    if (sent.kind === 'not_run_budget') return stopped(row.caseId, 'historical');
    if (sent.kind === 'capped') return technical(row.caseId, 'historical', 'error', Date.now() - started);
    if (sent.kind === 'timeout') return technical(row.caseId, 'historical', 'timeout', Date.now() - started);
    if (sent.kind !== 'result') return technical(row.caseId, 'historical', 'error', Date.now() - started);
    const raw = rawCritic(sent.content);
    const bound = strictBinding({ world: row.world, action: row.action, durationMs: Date.now() - started, raw });
    return {
      caseId: row.caseId,
      system: 'historical',
      status: 'result',
      verdict: raw && typeof raw.verdict === 'string' ? raw.verdict : null,
      executed: bound.executed,
      durationMs: Date.now() - started,
      secondary_called: false,
      public_verdict_stage: 'none',
      protocolError: bound.protocolError,
    };
  }
}

function stopped(caseId: string, system: 'sentinel' | 'historical'): SystemOutcome {
  return {
    caseId, system, status: 'not_run_budget', verdict: null, executed: false, durationMs: 0,
    secondary_called: false, public_verdict_stage: 'none', protocolError: null,
  };
}

function technical(caseId: string, system: 'sentinel' | 'historical', status: 'timeout' | 'error', durationMs: number): SystemOutcome {
  return {
    caseId, system, status, verdict: null, executed: false, durationMs,
    secondary_called: false, public_verdict_stage: 'none', protocolError: null,
  };
}

function rawCritic(content: string): { execute: unknown; verdict: unknown } | null {
  try {
    const parsed = JSON.parse(content) as { execute?: unknown; verdict?: unknown };
    if (!parsed || typeof parsed !== 'object') return null;
    return { execute: parsed.execute, verdict: parsed.verdict };
  } catch {
    return null;
  }
}

function pairFor(outcomes: readonly SystemOutcome[], caseId: string): PairStatus {
  const rows = outcomes.filter(item => item.caseId === caseId);
  if (rows.some(item => item.status === 'not_run_budget')) return 'incomplete_budget';
  return 'complete';
}
