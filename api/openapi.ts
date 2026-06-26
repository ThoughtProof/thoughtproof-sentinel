import type { VercelRequest, VercelResponse } from '@vercel/node';

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'ThoughtProof Sentinel API',
    description:
      'Pre-execution verification checkpoint for autonomous AI agents. Multi-model cascade evaluates agent reasoning before irreversible actions. Returns ALLOW, BLOCK, or UNCERTAIN with structured per-step objections and optional EAS on-chain attestation.',
    version: '0.1.0',
    guidance:
      'Use POST /sentinel/verify to check agent decisions before execution. Provide claim + evidence + mode. Auth via X-Sentinel-Key or x402 micropayment (USDC on Base). Tiers at GET /sentinel/tiers.',
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
        'x-payment-info': {
          pricingMode: 'tiered',
          tiers: {
            checkpoint: { price: '0.005000', cascade: ['serv-nano'] },
            standard: { price: '0.008000', cascade: ['serv-nano', 'serv-swift'], default: true },
          },
          asset: 'USDC',
          network: 'base',
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
                      'Optional machine-readable authorization mandate for action_authorization mode. Enables deterministic gate checks (amount limits, recipient allowlist) before the LLM.',
                    properties: {
                      granted: {
                        type: 'object',
                        description: 'Authorized parameters (maxAmount, allowedRecipients, etc.)',
                      },
                      action: {
                        type: 'object',
                        description: 'Proposed action to check against the mandate',
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
          '402': { description: 'x402 payment required (USDC on Base)' },
          '405': { description: 'Method not allowed (POST only)' },
          '413': { description: 'Request too large (max 1MB)' },
          '429': { description: 'Rate limit exceeded (120/min authenticated, 30/min anonymous)' },
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
                    ok: { type: 'boolean' },
                    version: { type: 'string' },
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
