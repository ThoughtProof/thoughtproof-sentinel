export type SentinelTier = 'checkpoint' | 'standard';

export type SentinelMode = 'handoff' | 'plan_revision' | 'memory_write' | 'output_synthesis' | 'trade_execution' | 'trade_reasoning';

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

/**
 * Per-step objection surfaced to the API client.
 *
 * This is the actionable substance the engine already computes internally
 * (pot-cli StepEvaluation) but historically discarded before the HTTP
 * boundary. Slimmed to the fields a consuming agent needs to re-plan:
 * which step failed, how badly (score), the verbatim quote it keyed on,
 * and why. Internal noise (quote_location, abstain_if_uncertain,
 * quote_to_criterion_mapping) is intentionally omitted.
 */
export interface SentinelStepObjection {
  /** Gold-step identifier (e.g. 'step_0') */
  step_id: string;
  /** Human-readable description of what this step checks (the gold-step criterion) */
  criterion: string;
  /** Support score, 0.0–1.0 */
  score: number;
  /** Graded/faithfulness predicate (e.g. 'supported', 'partial', 'unsupported') */
  predicate: string;
  /** Verbatim quote from evidence the evaluator keyed on, if any */
  quote: string | null;
  /**
   * Per-step reasoning. Uses the evaluator's prose when present; otherwise a
   * deterministic fallback synthesized from predicate + criterion (the cheap
   * SERV tiers do not always emit per-step prose).
   */
  reasoning: string;
}

export interface SentinelVerifyResponse {
  id: string;
  verdict: SentinelVerdict;
  confidence: number;
  reasoning: string;
  /**
   * Structured per-step objections (since 2026-06-13). The actionable
   * substance behind the verdict — empty array if the evaluator produced
   * no step evaluations. Consumers can filter to low scores / failing
   * predicates to drive agent re-planning.
   */
  objections: SentinelStepObjection[];
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
