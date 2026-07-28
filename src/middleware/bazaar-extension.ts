/**
 * x402 v2 Bazaar discovery extension (AgentCash / CDP Facilitator).
 *
 * Shape mirrors `@x402/extensions` declareDiscoveryExtension() output:
 * - info: example values the facilitator validates against schema
 * - schema: JSON Schema for info (NOT the raw request body schema alone)
 *
 * Keep this hand-rolled (no @x402/extensions runtime dep) but byte-compatible.
 */

const MODE_ENUM = [
  'handoff',
  'plan_revision',
  'memory_write',
  'output_synthesis',
  'trade_execution',
  'trade_reasoning',
  'action_authorization',
] as const;

const BODY_PROPERTIES = {
  id: { type: 'string', description: 'Optional verification ID (auto-generated if omitted)' },
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
    enum: [...MODE_ENUM],
    description: 'Verification mode',
  },
  tier: {
    type: 'string',
    enum: ['checkpoint', 'standard'],
    description: 'Price/cascade tier',
  },
} as const;

const OUTPUT_EXAMPLE = {
  id: 'v_example',
  verdict: 'ALLOW',
  confidence: 0.91,
  reasoning: 'Decision is consistent with mandate and evidence',
  objections: [] as unknown[],
  mode: 'trade_execution',
  tier: 'checkpoint',
  meta: {
    duration_ms: 1200,
    models_used: ['serv-nano'],
  },
};

const OUTPUT_PROPERTIES = {
  id: { type: 'string' },
  verdict: { type: 'string', enum: ['ALLOW', 'BLOCK', 'UNCERTAIN'] },
  confidence: { type: 'number' },
  reasoning: { type: 'string' },
  objections: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        step_id: { type: 'string' },
        criterion: { type: 'string' },
        score: { type: 'number' },
        predicate: { type: 'string' },
        quote: { type: ['string', 'null'] },
        reasoning: { type: 'string' },
      },
    },
  },
  mode: { type: 'string' },
  tier: { type: 'string' },
  meta: {
    type: 'object',
    properties: {
      duration_ms: { type: 'number' },
      models_used: { type: 'array', items: { type: 'string' } },
      verified_at: { type: 'string' },
    },
  },
} as const;

const GUIDANCE =
  'POST JSON { claim, evidence, mode, tier? }. Auth: x402 payment (preferred for agents) or X-Sentinel-Key. Returns ALLOW|BLOCK|UNCERTAIN with structured objections for replan.';

/**
 * Build extensions.bazaar block for PaymentRequired / well-known catalog.
 * Optional tierHint is catalog-only metadata (not part of official bazaar schema).
 */
export function buildBazaarExtensions(opts?: { tierHint?: string; guidance?: string }) {
  const exampleBody = {
    claim: 'Sell 0.1 ETH only if mandate allows and evidence supports the trade',
    evidence: 'mandate maxAmount=0.1 ETH; market data and agent reasoning trace',
    mode: 'trade_execution',
    tier: (opts?.tierHint === 'standard' ? 'standard' : 'checkpoint') as 'checkpoint' | 'standard',
  };

  return {
    bazaar: {
      info: {
        input: {
          type: 'http',
          method: 'POST',
          bodyType: 'json',
          body: exampleBody,
        },
        output: {
          type: 'json',
          example: {
            ...OUTPUT_EXAMPLE,
            mode: exampleBody.mode,
            tier: exampleBody.tier,
          },
        },
      },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          input: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'http' },
              method: { type: 'string', enum: ['POST', 'PUT', 'PATCH'] },
              bodyType: { type: 'string', enum: ['json', 'form-data', 'text'] },
              body: {
                type: 'object',
                properties: BODY_PROPERTIES,
                required: ['claim', 'evidence', 'mode'],
              },
            },
            required: ['type', 'method', 'bodyType', 'body'],
            additionalProperties: false,
          },
          output: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              example: {
                type: 'object',
                properties: OUTPUT_PROPERTIES,
                required: [
                  'id',
                  'verdict',
                  'confidence',
                  'reasoning',
                  'objections',
                  'mode',
                  'tier',
                  'meta',
                ],
              },
            },
            required: ['type'],
          },
        },
        required: ['input'],
      },
      guidance: opts?.guidance ?? GUIDANCE,
      ...(opts?.tierHint ? { defaultTier: opts.tierHint } : {}),
    },
  };
}
