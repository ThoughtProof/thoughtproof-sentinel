import type { AuthorizationMandate, GateMode, GateViolation } from './engine/authorization-gate.js';

export type SentinelTier = 'checkpoint' | 'standard' | 'swift' | 'pro';

export type SentinelMode = 'handoff' | 'plan_revision' | 'memory_write' | 'output_synthesis' | 'trade_execution' | 'trade_reasoning' | 'action_authorization';

/**
 * Optional caller-declared context about the *acting* agent (not the verifier).
 * Used for graph/pilot reporting (model switches, per-agent windows). Never
 * required for verify; never inferred — omit rather than guess.
 *
 * IMPORTANT: Echoed on `meta.agent_context` only. **Not** included in
 * `sentinel.verdict.canonical.v1` / signature hash. Treat as unsigned
 * operator metadata unless a future receipt schema binds a context_hash.
 *
 * @since 2026-07-29 (Intuition pilot prep)
 */
export interface AgentContext {
  /** Operator-facing agent id (not automatically equal to verified ERC-8004) */
  agent_id?: string;
  /** ERC-8004 identity when known — still operator-declared unless identity_verified */
  erc8004?: {
    chainId: number;
    tokenId: string | number;
  };
  /**
   * How identity fields were established.
   * @default 'operator_declared' when agent_id or erc8004 present
   */
  identity_source?: 'operator_declared' | 'erc8004_registry' | 'api_key_binding';
  /**
   * Whether ThoughtProof verified identity against a registry.
   * Pilot v0: always false unless identity_source is registry/binding and checked.
   * @default false when identity fields present
   */
  identity_verified?: boolean;
  /** Declared acting model, e.g. "xai/grok-4" — self-report unless source says otherwise */
  agent_model?: string;
  /** Model provider label if separate from agent_model */
  agent_model_provider?: string;
  /**
   * Provenance of agent_model.
   * @default 'operator_declared' when agent_model present
   */
  agent_model_source?: 'operator_declared' | 'runtime_detected' | 'unknown';
  /**
   * Role of the declared model when multiple models are in the loop.
   * @default 'action_generator' when agent_model present
   */
  agent_model_role?: 'action_generator' | 'planner' | 'tool_caller' | 'other';
  /** Runtime / framework, e.g. "openclaw", "cb4a", "custom" */
  agent_runtime?: string;
  /** Skill or prompt bundle version */
  skill_version?: string;
  /**
   * External correlation id from the caller's system (cycle id, job id).
   * Distinct from Sentinel response `id` (verification id).
   * Alias: `request_id` accepted and normalized to this field.
   */
  external_request_id?: string;
  /** @deprecated use external_request_id */
  request_id?: string;
  session_id?: string;
  environment?: 'paper' | 'testnet' | 'live' | 'dev';
  /** Free-form operator tags (short strings only, no secrets/PII) */
  tags?: string[];
}

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
  /**
   * Optional machine-readable mandate for the deterministic authorization gate
   * (ADR-0019, action_authorization mode only). When supplied, the gate
   * hard-checks binary/unfixable authority violations (amount overshoot,
   * recipient mismatch, unlimited approval) BEFORE the LLM. Ignored by all
   * other modes. See engine/authorization-gate.ts.
   */
  mandate?: AuthorizationMandate;
  /**
   * Deterministic-gate rollout stage (action_authorization only). Default
   * 'shadow': the gate computes and logs but does NOT change the verdict.
   * 'enforce': a gate violation hard-BLOCKs. See shadow-mode-rollout.
   */
  gateMode?: GateMode;
  /**
   * Optional declared context about the acting agent (model, 8004 id, …).
   * Echoed on the response; does not affect the verdict.
   */
  agent_context?: AgentContext;
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
  /**
   * Deterministic authorization-gate result (ADR-0019, action_authorization
   * only). Present when a machine-readable mandate was supplied. In 'shadow'
   * mode this is informational (wouldBlock + violations logged, verdict
   * unchanged); in 'enforce' a violation forces verdict=BLOCK.
   */
  gate?: {
    mode: GateMode;
    wouldBlock: boolean;
    enforced: boolean;
    violations: GateViolation[];
  };
  meta: {
    duration_ms: number;
    models_used: string[];
    verified_at: string;
    /**
     * Present only when objection-evidence-bind gated at least one surface reason.
     * Verdict is never changed by the bind (surface text only).
     */
    objection_evidence_bind?: {
      surface_gated: boolean;
      n_evidence_fail: number;
      n_unverified: number;
      n_verified: number;
      codes: string[];
      verdict_unchanged: true;
    };
    /**
     * Echo of request.agent_context when supplied. Distinct from models_used
     * (verifier cascade). Omitted when caller sent nothing.
     */
    agent_context?: AgentContext;
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
