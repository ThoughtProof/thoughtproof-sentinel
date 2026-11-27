import { ADAPTER_ID, decideCascade, type AdapterExchange } from './adapter.ts';
import type { Document } from './contract.ts';
import { MODEL_CONFIG } from './model-config.ts';

export type PublicVerdictStage = 'primary' | 'secondary' | 'none';

export interface SentinelStageLog {
  secondary_called: boolean;
  public_verdict_stage: PublicVerdictStage;
  publicVerdict: 'ALLOW' | 'BLOCK' | 'UNCERTAIN' | null;
}

/**
 * Records which stage produced the public verdict.
 * A secondary call happens only after a pinned primary failure.
 * That stage's public verdict is BLOCK or UNCERTAIN, never ALLOW.
 */
export function sentinelStage(input: {
  documents: readonly Document[];
  primary: AdapterExchange;
  secondary: AdapterExchange | null;
}): SentinelStageLog {
  const primaryFailed = !input.primary.ok
    && (MODEL_CONFIG.cascade.when as readonly string[]).includes(input.primary.reason);
  const secondaryCalled = primaryFailed && input.secondary !== null;
  const result = decideCascade(input.documents, input.primary, input.secondary, { trustedAdapterIds: [ADAPTER_ID] });
  const decision = result.decision;
  const publicVerdict = decision === 'ALLOW' || decision === 'BLOCK' || decision === 'UNCERTAIN' ? decision : null;
  if (secondaryCalled && publicVerdict === 'ALLOW') throw new Error('SECONDARY_PUBLISHED_ALLOW');
  return {
    secondary_called: secondaryCalled,
    public_verdict_stage: secondaryCalled ? 'secondary' : 'primary',
    publicVerdict,
  };
}
