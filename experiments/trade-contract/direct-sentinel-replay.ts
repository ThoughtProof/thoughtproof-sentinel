import { readFileSync, readdirSync } from 'node:fs';
import { ADAPTER_ID, decideCascade } from './adapter.ts';
import { applySharedHost, prepareModelContent } from './comparison-grounding.ts';
import { orderCaseById } from './dev-v3/cases.ts';
import { simulatedExecution, type BindingDecision, type ProviderCall } from './direct-historical.ts';

const ARCHIVE = new URL('./fixtures/orddev-v3-20261127/', import.meta.url);
const TICKS_PER_USD = 10_000_000_000;

export interface SentinelControlRow {
  caseId: string;
  systemVerdict: BindingDecision['systemVerdict'];
  durationMs: number;
  executed: boolean;
  measuredUsd: number;
  providerCalls: ProviderCall[];
}

function verdictOf(decision: string): 'ALLOW' | 'BLOCK' | 'UNCERTAIN' {
  if (decision === 'ALLOW' || decision === 'BLOCK' || decision === 'UNCERTAIN') return decision;
  return 'UNCERTAIN';
}

/** Offline replay of stored arm B answers. No provider call. */
export function replayFrozenArmB(): SentinelControlRow[] {
  const report = JSON.parse(readFileSync(new URL('report.json', ARCHIVE), 'utf8')) as {
    rows: { caseId: string; arm: string; durationMs: number }[];
  };
  const rows: SentinelControlRow[] = [];
  for (const name of readdirSync(new URL('raw/', ARCHIVE)).filter(item => item.endsWith('-B.json')).sort()) {
    const saved = JSON.parse(readFileSync(new URL(`raw/${name}`, ARCHIVE), 'utf8')) as {
      caseId: string;
      content: string;
      usage?: { cost_in_usd_ticks?: number };
    };
    const recorded = report.rows.find(row => row.caseId === saved.caseId && row.arm === 'B');
    if (!recorded) throw new Error(`MISSING_DURATION:${saved.caseId}`);
    const documents = orderCaseById(saved.caseId).documents;
    const prepared = prepareModelContent(saved.content, documents, 'primary');
    const frozen = prepared.schemaFailure
      ? null
      : decideCascade(documents, { ok: true, content: prepared.publicContent }, null, { trustedAdapterIds: [ADAPTER_ID] });
    const systemVerdict = !frozen || prepared.schemaFailure
      ? 'INFRA_ERROR'
      : verdictOf(applySharedHost(verdictOf(frozen.decision), prepared.grounding, documents));
    const providerCalls: ProviderCall[] = [
      { stage: 'primary', model: 'grok-4.7', status: 'completed' },
      { stage: 'secondary', model: 'grok-4.3', status: 'not_sent' },
    ];
    const decision: BindingDecision = {
      arm: 'sentinel_b',
      systemVerdict,
      durationMs: recorded.durationMs,
      providerCalls,
      reasons: [],
    };
    rows.push({
      caseId: saved.caseId,
      systemVerdict,
      durationMs: recorded.durationMs,
      executed: simulatedExecution(decision).executed,
      measuredUsd: (saved.usage?.cost_in_usd_ticks ?? 0) / TICKS_PER_USD,
      providerCalls,
    });
  }
  return rows;
}
