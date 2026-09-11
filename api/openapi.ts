import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  AUTHENTICATED_RATE_LIMIT_PER_MINUTE,
  GLOBAL_RATE_LIMIT_PER_MINUTE_DEFAULT,
} from '../src/rate-limit-policy.js';
import { getPotCliVersion } from '../src/runtime-versions.js';

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'ThoughtProof Sentinel API',
    description:
      'Pre-execution verification checkpoint for autonomous AI agents. Multi-model cascade evaluates agent reasoning before irreversible actions. Returns ALLOW, BLOCK, or UNCERTAIN with structured per-step objections and optional EAS on-chain attestation.',
    version: '0.1.0',
    'x-pot-cli': getPotCliVersion(),
    // AgentCash discovery reads info.x-guidance; keep legacy guidance too.
    guidance:
      'Use POST /sentinel/verify to check agent decisions before execution. Provide claim + evidence + mode. Auth via X-Sentinel-Key or x402 micropayment (USDC on Base). Tiers at GET /sentinel/tiers.',
    'x-guidance':
      'Use POST /sentinel/verify to check agent decisions before execution. Provide claim + evidence + mode. Auth via X-Sentinel-Key or x402 micropayment (USDC on Base / eip155:8453, optional XRPL RLUSD). Tiers at GET /sentinel/tiers. Unauthenticated probes should receive HTTP 402 with extensions.bazaar input/output schemas.',
    contact: {
      url: 'https://thoughtproof.ai',
      email: 'support@thoughtproof.ai',
    },
  },
  servers: [
    {
      url: 'https://sentinel.thoughtproof.ai',
      description: 'Production',
    },
  ],
  security: [{ sentinelKey: [] }],
  paths: {
    '/sentinel/verify': {
      post: {
        operationId: 'sentinelVerify',
        summary: 'Verify agent reasoning before execution',
        description:
          'Multi-model cascade verification. A fast nano model screens first; if escalation is needed, a stronger second model re-evaluates. Returns one of three verdicts — ALLOW, BLOCK, or UNCERTAIN — with structured per-step objections agents can use to re-plan. Supports x402 micropayment on Base (USDC).',
        // Structured x-payment-info (AgentCash non-legacy). Live 402 challenges
        // still dual-advertise network base + eip155:8453 for facilitators.
        'x-payment-info': {
          price: {
            mode: 'tiered',
            currency: 'USDC',
            network: 'eip155:8453',
            tiers: {
              checkpoint: { amount: '0.005000', cascade: ['serv-nano'] },
              standard: {
                amount: '0.008000',
                cascade: ['serv-nano', 'serv-swift'],
                default: true,
              },
            },
          },
          protocols: [{ x402: { networks: ['eip155:8453', 'xrpl:0'] } }],
        },
        // Keep legacy flat form for older crawlers (additive, not exclusive).
        'x-payment-info-legacy': {
          pricingMode: 'tiered',
          tiers: {
            checkpoint: { price: '0.005000', cascade: ['serv-nano'] },
            standard: { price: '0.008000', cascade: ['serv-nano', 'serv-swift'], default: true },
          },
          asset: 'USDC',
          network: 'eip155:8453',
          protocols: ['x402'],
        },
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['claim', 'evidence', 'mode'],
                properties: {
                  id: {
                    type: 'string',
                    description: 'Optional verification ID (auto-generated if omitted)',
                  },
                  claim: {
                    type: 'string',
                    description: 'The agent decision or action to verify',
                    maxLength: 100000,
                  },
                  evidence: {
                    type: 'string',
                    description: 'Context, reasoning trace, or market data supporting the claim',
                    maxLength: 500000,
                  },
                  mode: {
                    type: 'string',
                    enum: [
                      'handoff',
                      'plan_revision',
                      'memory_write',
                      'output_synthesis',
                      'trade_execution',
                      'trade_reasoning',
                      'action_authorization',
                    ],
                    description:
                      'Verification mode. handoff: agent-to-agent delegation. plan_revision: plan change review. memory_write: persistent memory gate. output_synthesis: final output check. trade_execution/trade_reasoning: financial decision verification. action_authorization: deterministic gate + LLM.',
                  },
                  tier: {
                    type: 'string',
                    enum: ['checkpoint', 'standard'],
                    default: 'standard',
                    description:
                      'Verification tier. checkpoint: nano solo ($0.005). standard: 2-model cascade ($0.008, default).',
                  },
                  mandate: {
                    type: 'object',
                    description:
                      'Optional machine-readable authorization mandate for action_authorization mode. Enables deterministic gate checks (amount limits, recipient allowlist) before the LLM. Optional mandate.kind / mandate.action.kind (ActionKind) are caller-declared (API caller, often the model). BLOCK: declared kind always applies; declared unknown stays unknown. ALLOW: kind-pair unlocks only when prose does not contradict (informational requires caller and prose agree; financial unknown prose may confirm via structured granted.maxAmount/recipient). MCP action.kind maps to mandate.action.kind.',
                    properties: {
                      kind: {
                        type: 'string',
                        enum: [
                          'informational',
                          'value_transfer',
                          'permission',
                          'deploy_ship',
                          'unknown',
                        ],
                        description:
                          'Caller-declared mandate kind (issue #51). BLOCK always applies; ALLOW requires prose not to contradict.',
                      },
                      granted: {
                        type: 'object',
                        description:
                          'Authorized parameters (maxAmount, asset, recipient, allowUnlimited). Preferred for the financial gate when present — amounts and addresses as data.',
                      },
                      action: {
                        type: 'object',
                        description:
                          'Proposed action to check against the mandate. kind is the caller-declared action kind (MCP action.kind).',
                        properties: {
                          kind: {
                            type: 'string',
                            enum: [
                              'informational',
                              'value_transfer',
                              'permission',
                              'deploy_ship',
                              'unknown',
                            ],
                            description:
                              'Caller-declared action kind (issue #51). BLOCK always applies; ALLOW requires prose not to contradict.',
                          },
                          amount: { type: 'number' },
                          asset: { type: 'string' },
                          recipient: { type: 'string' },
                          allowance: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                        },
                      },
                    },
                  },
                  gateMode: {
                    type: 'string',
                    enum: ['shadow', 'enforce'],
                    default: 'shadow',
                    description:
                      'Deterministic gate rollout stage (action_authorization only). shadow: logs violations but does not change verdict. enforce: violation forces BLOCK.',
                  },
                  agent_context: {
                    type: 'object',
                    description:
                      'Optional caller-declared context about the *acting* agent (not the verifier cascade). Echoed on response.meta.agent_context. Does NOT affect the verdict and is NOT included in the canonical verdict hash/signature — unsigned operator metadata for pilot reporting.',
                    properties: {
                      agent_id: { type: 'string', description: 'Operator agent id' },
                      erc8004: {
                        type: 'object',
                        properties: {
                          chainId: { type: 'number' },
                          tokenId: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                        },
                      },
                      identity_source: {
                        type: 'string',
                        enum: ['operator_declared', 'erc8004_registry', 'api_key_binding'],
                        description: 'Defaults to operator_declared when identity fields present',
                      },
                      identity_verified: {
                        type: 'boolean',
                        description: 'true only with registry/binding source; pilot default false',
                      },
                      agent_model: {
                        type: 'string',
                        description: 'Declared acting model, e.g. xai/grok-4 (self-report)',
                      },
                      agent_model_provider: { type: 'string' },
                      agent_model_source: {
                        type: 'string',
                        enum: ['operator_declared', 'runtime_detected', 'unknown'],
                      },
                      agent_model_role: {
                        type: 'string',
                        enum: ['action_generator', 'planner', 'tool_caller', 'other'],
                      },
                      agent_runtime: {
                        type: 'string',
                        description: 'e.g. openclaw, cb4a, custom',
                      },
                      skill_version: { type: 'string' },
                      external_request_id: {
                        type: 'string',
                        description: 'Caller correlation id (cycle/job). Distinct from response verification id.',
                      },
                      request_id: {
                        type: 'string',
                        description: 'Deprecated alias for external_request_id',
                        deprecated: true,
                      },
                      session_id: { type: 'string' },
                      environment: {
                        type: 'string',
                        enum: ['paper', 'testnet', 'live', 'dev'],
                      },
                      tags: {
                        type: 'array',
                        items: { type: 'string' },
                        maxItems: 16,
                      },
                    },
                  },
                },
              },
              examples: {
                trade_execution: {
                  summary: 'Verify a trade execution decision',
                  value: {
                    claim: 'BUY 0.5 ETH at $3,400 — momentum breakout above 20-day SMA with rising volume',
                    evidence:
                      'ETH/USD at $3,401. 20-day SMA: $3,380. 24h volume: $18.2B (+15%). RSI: 62. Funding rate: 0.01%.',
                    mode: 'trade_execution',
                    tier: 'standard',
                  },
                },
                handoff: {
                  summary: 'Verify an agent handoff decision',
                  value: {
                    claim: 'Delegate customer refund processing to payment-agent-v2',
                    evidence:
                      'Customer requested refund for order #4521. Amount: $45.00. Within 30-day return policy. Item returned and received.',
                    mode: 'handoff',
                    tier: 'checkpoint',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Verification result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'verdict', 'confidence', 'reasoning', 'objections', 'mode', 'tier', 'meta'],
                  properties: {
                    id: { type: 'string', example: 'req_m1abc_x9f2kq' },
                    verdict: {
                      type: 'string',
                      enum: ['ALLOW', 'BLOCK', 'UNCERTAIN'],
                      description:
                        'ALLOW: reasoning verified, safe to execute. BLOCK: critical failures found. UNCERTAIN: insufficient evidence.',
                    },
                    confidence: {
                      type: 'number',
                      minimum: 0,
                      maximum: 1,
                      example: 0.85,
                    },
                    reasoning: {
                      type: 'string',
                      description: 'Top-level reasoning for the verdict',
                    },
                    objections: {
                      type: 'array',
                      description:
                        'Structured per-step objections. Agents can filter by low scores to drive re-planning.',
                      items: {
                        type: 'object',
                        properties: {
                          step_id: { type: 'string', example: 'step_0' },
                          criterion: { type: 'string' },
                          score: { type: 'number', minimum: 0, maximum: 1 },
                          predicate: {
                            type: 'string',
                            enum: ['supported', 'partial', 'unsupported'],
                          },
                          quote: { type: ['string', 'null'] },
                          quote_source: {
                            type: ['string', 'null'],
                            enum: ['cascade', 'recovered_mandate', null],
                            description:
                              'cascade: evaluator cited this span. recovered_mandate: Sentinel filled a missing cite from the MCP Principal mandate (verbatim quote) span. Null when quote is null.',
                          },
                          quote_match_mode: {
                            type: 'string',
                            enum: ['exact', 'trimmed', 'line_whitespace', 'unicode', 'none'],
                            description:
                              'How quote matched evidence. unicode/whitespace matches return the evidence span, not the LLM folding.',
                          },
                          reasoning: { type: 'string' },
                        },
                      },
                    },
                    mode: { type: 'string' },
                    tier: { type: 'string' },
                    gate: {
                      type: 'object',
                      description: 'Deterministic authorization-gate result (action_authorization mode only)',
                      properties: {
                        mode: { type: 'string', enum: ['shadow', 'enforce'] },
                        wouldBlock: { type: 'boolean' },
                        enforced: { type: 'boolean' },
                        violations: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              type: { type: 'string' },
                              message: { type: 'string' },
                            },
                          },
                        },
                      },
                    },
                    meta: {
                      type: 'object',
                      properties: {
                        duration_ms: { type: 'integer', example: 1200 },
                        models_used: {
                          type: 'array',
                          items: { type: 'string' },
                          example: ['serv-nano', 'serv-swift'],
                        },
                        verified_at: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid request (missing required fields or invalid mode/tier)' },
          '401': { description: 'Missing or invalid X-Sentinel-Key' },
          '503': {
            description:
              'Verifier model config missing (e.g. SERV_API_KEY unset). Gate-down — not a verdict and not model uncertainty. Distinct from 500 INTERNAL_ERROR.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['error', 'code', 'request_id'],
                  properties: {
                    error: { type: 'string', example: 'Verification service temporarily unavailable' },
                    code: {
                      type: 'string',
                      enum: ['MODEL_CONFIG_MISSING'],
                      description: 'Dedicated code so MCP hosts treat gate-down ≠ cascade UNCERTAIN',
                    },
                    request_id: { type: 'string' },
                  },
                },
              },
            },
          },
          '402': {
            description:
              'x402 payment required. Live challenges dual-advertise network base + eip155:8453 for facilitator compatibility; discovery catalog (/.well-known/x402) is CAIP-2-only.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    protocol: { type: 'string', enum: ['x402'] },
                    intentId: { type: 'string' },
                    x402Version: { type: 'integer', example: 2 },
                    accepts: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          scheme: { type: 'string' },
                          network: {
                            type: 'string',
                            description:
                              'CAIP-2 (eip155:8453) and/or legacy base on live challenges; catalog is CAIP-2-only',
                          },
                          amount: { type: 'string' },
                          asset: { type: 'string' },
                          payTo: { type: 'string' },
                        },
                      },
                    },
                    resource: { type: 'object' },
                    extensions: {
                      type: 'object',
                      properties: {
                        bazaar: {
                          type: 'object',
                          properties: {
                            schema: {
                              type: 'object',
                              properties: {
                                properties: {
                                  type: 'object',
                                  properties: {
                                    input: {
                                      type: 'object',
                                      description:
                                        'Request body schema for POST /sentinel/verify (claim, evidence, mode, tier?)',
                                    },
                                    output: {
                                      type: 'object',
                                      description:
                                        '200 response schema (id, verdict, confidence, reasoning, objections, mode, tier, meta)',
                                    },
                                  },
                                  required: ['input', 'output'],
                                },
                              },
                            },
                            guidance: { type: 'string' },
                          },
                        },
                      },
                    },
                    payment: { type: 'object' },
                    instructions: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          '405': { description: 'Method not allowed (POST only)' },
          '413': { description: 'Request too large (max 1MB)' },
          '429': {
            description: `Rate limit exceeded (${AUTHENTICATED_RATE_LIMIT_PER_MINUTE}/min authenticated, ${GLOBAL_RATE_LIMIT_PER_MINUTE_DEFAULT}/min anonymous)`,
          },
        },
      },
    },
    '/sentinel/tiers': {
      get: {
        operationId: 'sentinelTiers',
        summary: 'List available Sentinel verification tiers',
        description:
          'Returns tier metadata including pricing, cascade composition, accuracy, and which tier is the current default.',
        security: [],
        responses: {
          '200': {
            description: 'Tier metadata',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    tiers: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          tier: { type: 'string' },
                          label: { type: 'string' },
                          price_usd: { type: 'number' },
                          cascade: { type: 'array', items: { type: 'string' } },
                          accuracy: { type: 'number' },
                          false_allows: { type: 'integer' },
                          latency_median: { type: 'string' },
                          default: { type: 'boolean' },
                          notes: { type: 'string' },
                        },
                      },
                    },
                    default_tier: { type: 'string' },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/sentinel/health': {
      get: {
        operationId: 'sentinelHealth',
        summary: 'Health check',
        security: [],
        responses: {
          '200': {
            description: 'Service health',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: {
                      type: 'boolean',
                      description: 'Liveness: process answered. Not a cascade readiness signal.',
                    },
                    ready: {
                      type: 'boolean',
                      description:
                        'Readiness. false when SERV_API_KEY is missing, rate_limit is unavailable, or VERCEL_ENV=production and rate_limit is in_memory. ok remains liveness-only.',
                    },
                    serv_key: {
                      type: 'string',
                      enum: ['present', 'missing'],
                      description:
                        'SERV_API_KEY presence only. Never the key value. missing ⇒ ready=false.',
                    },
                    rate_limit: {
                      type: 'string',
                      enum: ['redis', 'in_memory', 'unavailable'],
                      description:
                        'Limiter store from env probe only — not connectivity-checked (no Redis PING). redis = Upstash REST URL+token configured; in_memory = Redis unset (dev fallback); unavailable = configured-but-invalid (fail-closed). unavailable ⇒ ready=false. redis does not prove limit() will succeed.',
                    },
                    version: { type: 'string', description: 'Sentinel service version' },
                    pot_cli: {
                      type: 'string',
                      description:
                        'Installed pot-cli package version (from pot-cli/package.json). ThoughtProof vendor patches use a prerelease suffix (e.g. 0.8.10-tp.1), never a colliding upstream 0.8.10.',
                    },
                    modes: { type: 'array', items: { type: 'string' } },
                    tiers: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      sentinelKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Sentinel-Key',
        description: 'ThoughtProof Sentinel API key. Alternative: x402 micropayment (USDC on Base).',
      },
    },
  },
};

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(spec);
}
