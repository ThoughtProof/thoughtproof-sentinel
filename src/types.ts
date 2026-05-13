export type SentinelTier = 'checkpoint' | 'standard';

export type SentinelMode = 'handoff' | 'plan_revision' | 'memory_write' | 'output_synthesis';

export interface SentinelVerifyRequest {
  /** Unique identifier (optional, auto-generated) */
  id?: string;
  /** The claim to verify */
  claim: string;
  /** Evidence supporting or contradicting the claim */
  evidence: string;
  /** Verification mode */
  mode: SentinelMode;
  /** Tier selection (default: standard) */
  tier?: SentinelTier;
}

export type SentinelVerdict = 'ALLOW' | 'BLOCK' | 'UNCERTAIN';

export interface SentinelVerifyResponse {
  id: string;
  verdict: SentinelVerdict;
  confidence: number;
  reasoning: string;
  mode: SentinelMode;
  tier: SentinelTier;
  meta: {
    duration_ms: number;
    models_used: string[];
    verified_at: string;
  };
}

export interface SentinelHealthResponse {
  ok: boolean;
  version: string;
  modes: SentinelMode[];
  tiers: SentinelTier[];
}
