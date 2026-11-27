import { ADAPTER_ID, decideCascade, parseOutput } from './adapter.ts';
import type { Document } from './contract.ts';
import { applySharedHost, prepareModelContent } from './comparison-grounding.ts';
import type { ComparisonArm } from './comparison-prompt.ts';

export type ProviderStatus = 'ok' | 'http_error' | 'timeout' | 'transport_error' | 'empty' | 'not_sent';
export type ParserResult = 'ok' | 'empty' | 'parse_error' | 'schema_violation' | 'missing_checks' | 'not_run';
export type GateVerdict = 'ALLOW' | 'BLOCK' | 'UNCERTAIN';

export interface ArmCaseRow {
  caseId: string;
  arm: ComparisonArm;
  providerStatus: ProviderStatus;
  /** `ok`, or the frozen parser's rejection. `not_run` when the provider did not return a body. */
  parserResult: ParserResult;
  frozenGateVerdict: GateVerdict | null;
  /** Frozen gate, then the shared grounding follow-up. A parser rejection stays the gate's UNCERTAIN. */
  publicVerdict: GateVerdict | null;
  /** First step that is not on the path to ALLOW. Null when the public verdict is ALLOW. */
  firstAllowBlocker: string | null;
  countsAs: 'provider_or_schema' | 'validator_rejection' | 'substantive_uncertain' | 'other';
}

function asVerdict(decision: string): GateVerdict | null {
  return decision === 'ALLOW' || decision === 'BLOCK' || decision === 'UNCERTAIN' ? decision : null;
}

/**
 * Reads the frozen parser (`adapter.ts` `parseOutput`) on the same bytes the
 * gate receives, then the frozen gate, then the grounding follow-up.
 */
export function assessModelText(
  documents: readonly Document[],
  content: string,
): Pick<ArmCaseRow, 'parserResult' | 'frozenGateVerdict' | 'publicVerdict'> {
  const prepared = prepareModelContent(content, documents, 'primary');
  const parsed = parseOutput(prepared.publicContent);
  const rejection = 'failure' in parsed ? parsed.failure : null;
  const parserResult: ParserResult = rejection === 'empty' || rejection === 'parse_error'
    || rejection === 'schema_violation' || rejection === 'missing_checks'
    ? rejection
    : rejection === null ? 'ok' : 'schema_violation';
  const frozen = decideCascade(
    documents,
    { ok: true, content: prepared.publicContent },
    null,
    { trustedAdapterIds: [ADAPTER_ID] },
  );
  const frozenGateVerdict = asVerdict(frozen.decision);
  const publicVerdict = parserResult === 'ok' && frozenGateVerdict
    ? applySharedHost(frozenGateVerdict, prepared.grounding, documents)
    : frozenGateVerdict;
  return { parserResult, frozenGateVerdict, publicVerdict };
}

export function firstAllowBlocker(row: Pick<ArmCaseRow, 'providerStatus' | 'parserResult' | 'frozenGateVerdict' | 'publicVerdict'>): string | null {
  if (row.publicVerdict === 'ALLOW') return null;
  if (row.providerStatus !== 'ok') return `provider:${row.providerStatus}`;
  if (row.parserResult !== 'ok') return `parser:${row.parserResult}`;
  if (row.frozenGateVerdict !== 'ALLOW') return `frozen_gate:${row.frozenGateVerdict ?? 'none'}`;
  return 'grounding_follow_up';
}

export function countsFor(row: Pick<ArmCaseRow, 'providerStatus' | 'parserResult' | 'publicVerdict'>): ArmCaseRow['countsAs'] {
  if (row.providerStatus !== 'ok') return 'provider_or_schema';
  if (row.parserResult !== 'ok' && row.parserResult !== 'not_run') return 'validator_rejection';
  if (row.publicVerdict === 'UNCERTAIN') return 'substantive_uncertain';
  return 'other';
}

export function armCaseRow(input: {
  caseId: string;
  arm: ComparisonArm;
  providerStatus: ProviderStatus;
  documents?: readonly Document[];
  content?: string;
}): ArmCaseRow {
  if (input.providerStatus !== 'ok' || input.documents === undefined || input.content === undefined) {
    const base = {
      caseId: input.caseId,
      arm: input.arm,
      providerStatus: input.providerStatus,
      parserResult: 'not_run' as const,
      frozenGateVerdict: null,
      publicVerdict: null,
    };
    return { ...base, firstAllowBlocker: firstAllowBlocker(base), countsAs: countsFor(base) };
  }
  const assessed = assessModelText(input.documents, input.content);
  const base = { caseId: input.caseId, arm: input.arm, providerStatus: input.providerStatus, ...assessed };
  return { ...base, firstAllowBlocker: firstAllowBlocker(base), countsAs: countsFor(base) };
}

/** Named only when every dev-06 arm row is public UNCERTAIN. */
export function dev06AllowBlocker(rows: readonly ArmCaseRow[]): { bothUncertain: boolean; firstAllowBlocker: string | null } {
  const arms = rows.filter(row => row.caseId === 'dev-06');
  if (arms.length < 2 || arms.some(row => row.publicVerdict !== 'UNCERTAIN')) {
    return { bothUncertain: false, firstAllowBlocker: null };
  }
  const steps = [...new Set(arms.map(row => `${row.arm}:${row.firstAllowBlocker}`))];
  return { bothUncertain: true, firstAllowBlocker: steps.join('; ') };
}
