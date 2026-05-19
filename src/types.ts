export type SentinelTier = 'checkpoint' | 'standard';

export type SentinelMode = 'handoff' | 'plan_revision' | 'memory_write' | 'output_synthesis' | 'trade_execution';

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

// --- EAS Attestation Types ---

export interface AttestationData {
  verificationId: string;
  qualified: boolean;
  qualification: string;
  apiVersion: string;
  tier: SentinelTier;
  mode: SentinelMode;
  verdict: SentinelVerdict;
  confidence: number;
  claimHash: string;   // bytes32 keccak256 of claim
  evidenceHash: string; // bytes32 keccak256 of evidence
  evaluatedAt: number;  // unix timestamp
}

export interface AttestationResult {
  uid: string;
  txHash: string;
  attester: string;
  schemaUid: string;
}

// --- Payment / Billing Types (ADR-0017) ---

export type PaymentPlatform = 'openserv' | 'acp' | 'direct';

export interface BillingEvent {
  verification_id: string;
  tier: SentinelTier;
  price_usd: number;
  mode: SentinelMode;
  models_used: string[];
  duration_ms: number;
  timestamp: string;   // ISO 8601
  platform: PaymentPlatform;
  agent_id?: string;   // platform-specific identifier
}

export interface PaymentAdapter {
  /** Process a billing event. Returns settlement reference or null if deferred (batch). */
  process(event: BillingEvent): Promise<{ settled: boolean; reference?: string }>;
  /** Flush any batched events. Called periodically or on shutdown. */
  flush?(): Promise<{ settled_count: number; tx_hash?: string }>;
}
