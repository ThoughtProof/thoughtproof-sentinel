import { VERDICT_SCHEMA_ID } from './verdict-schema.ts';

/**
 * Pinned xAI chat-completions configuration. This module never calls the API
 * and never reads an API key.
 *
 * Docs retrieved 2026-11-24:
 * - Models and prices: https://docs.x.ai/docs/models
 * - Chat completions request fields, including seed and max_completion_tokens:
 *   https://docs.x.ai/developers/rest-api-reference/inference/chat-completions
 * - Structured outputs (`response_format.type` `json_schema`, `strict`):
 *   https://docs.x.ai/docs/guides/structured-outputs
 *
 * Primary is grok-4.7, the model that page names for chat. Secondary is
 * grok-4.3, a distinct text model on the same page. Prices are the global
 * endpoint rates. The long-context row is the public worst case once the
 * prompt reaches 200k tokens. The US regional endpoint is not used; it bills
 * 1.1x and is not this URL.
 *
 * `seed` is sent because that reference documents it. Determinism is best
 * effort and not guaranteed. `max_tokens` is deprecated there and is not sent;
 * `max_completion_tokens` is the documented field.
 *
 * `reasoning_effort` is a chat-completions body field. grok-4.7 accepts
 * low/medium/high/xhigh and defaults to high, so it is pinned to low, the
 * lowest value that page lists (reasoning cannot be turned off). grok-4.3
 * also accepts none, so it is pinned to none. See
 * https://docs.x.ai/developers/models/grok-4.7 and
 * https://docs.x.ai/developers/models/grok-4.3.
 * The per-call timeout is 900s, the minimum the best-practices guide tells
 * clients to allow: https://docs.x.ai/developers/model-capabilities/text/best-practices
 * Retrieved 2026-11-24. `max_completion_tokens` does not cap reasoning tokens.
 *
 * A schema-valid primary decision does not fall through. On fall-through the
 * secondary is block-only: BLOCK stays BLOCK; ALLOW, CONDITIONAL_ALLOW, HOLD,
 * and any other non-BLOCK outcome become UNCERTAIN. If the secondary also
 * fails, the result is UNCERTAIN.
 *
 * Body leaves are copied into the chat-completions JSON. Runner leaves are
 * not: endpoint, docs, prices, timeout, retries, and the cascade policy.
 */
export const XAI_CHAT_COMPLETIONS_URL = 'https://api.x.ai/v1/chat/completions';

/** Runner client timeout. Not a JSON body field. Best-practices minimum is 900s. */
export const XAI_REQUEST_TIMEOUT_MS = 900_000;

const priceSource = {
  currency: 'USD',
  per: '1M_tokens',
  docUrl: 'https://docs.x.ai/docs/models',
  retrievedOn: '2026-11-24',
  longContextFromPromptTokens: 200_000,
} as const;

export const MODEL_CONFIG = {
  provider: 'xai',
  transport: 'openai-compatible',
  baseUrl: 'https://api.x.ai/v1',
  chatPath: '/chat/completions',
  docs: {
    models: 'https://docs.x.ai/docs/models',
    chatCompletions: 'https://docs.x.ai/developers/rest-api-reference/inference/chat-completions',
    structuredOutputs: 'https://docs.x.ai/docs/guides/structured-outputs',
    retrievedOn: '2026-11-24',
  },
  responseFormat: {
    type: 'json_schema',
    name: 'trade_contract_adapter_v1',
    strict: true,
    schemaId: VERDICT_SCHEMA_ID,
  },
  primary: {
    model: 'grok-4.7',
    temperature: 0,
    seed: 42,
    max_completion_tokens: 4096,
    reasoning_effort: 'low',
    pricing: {
      ...priceSource,
      contextTokens: 500_000,
      shortContext: { input: 2, cachedInput: 0.5, output: 6 },
      longContext: { input: 4, cachedInput: 1, output: 12 },
    },
  },
  cascade: {
    secondary: {
      model: 'grok-4.3',
      temperature: 0,
      seed: 42,
      max_completion_tokens: 4096,
      reasoning_effort: 'none',
      pricing: {
        ...priceSource,
        contextTokens: 1_000_000,
        shortContext: { input: 1.25, cachedInput: 0.2, output: 2.5 },
        longContext: { input: 2.5, cachedInput: 0.4, output: 5 },
      },
    },
    when: [
      'timeout',
      'transport_error',
      'http_error',
      'empty',
      'parse_error',
      'schema_violation',
      'missing_checks',
    ],
    /** Secondary may publish only BLOCK. Every other outcome, including failure, is UNCERTAIN. */
    secondaryPolicy: 'block_only',
    onSecondaryBlock: 'BLOCK',
    onSecondaryNonBlock: 'UNCERTAIN',
    onSecondaryFailure: 'UNCERTAIN',
    confirmBlocks: false,
    retriesPerModel: 0,
    timeoutMs: XAI_REQUEST_TIMEOUT_MS,
  },
} as const;

export type CascadeFailure = (typeof MODEL_CONFIG.cascade.when)[number];

type BodyField = { role: 'body'; wire: string; stage?: 'primary' | 'secondary' };
type RunnerField = { role: 'runner'; reason: string };

const RUNNER_REASON = 'Not a chat-completions JSON field. The runner or this adapter applies it.';

/** Every MODEL_CONFIG leaf is either copied into the request body or explicitly left out. */
export function classifyConfigPath(path: string): BodyField | RunnerField {
  if (path === 'responseFormat.type' || path === 'responseFormat.name' || path === 'responseFormat.strict') {
    return { role: 'body', wire: 'response_format' };
  }
  const stageField = /^(primary|cascade\.secondary)\.(model|temperature|seed|max_completion_tokens|reasoning_effort)$/.exec(path);
  if (stageField) {
    return {
      role: 'body',
      wire: stageField[2],
      stage: stageField[1] === 'primary' ? 'primary' : 'secondary',
    };
  }
  if (
    path === 'provider' || path === 'transport' || path === 'baseUrl' || path === 'chatPath'
    || path === 'responseFormat.schemaId'
    || path.startsWith('docs.')
    || path.startsWith('primary.pricing.')
    || path.startsWith('cascade.secondary.pricing.')
    || path === 'cascade.when' || path === 'cascade.secondaryPolicy'
    || path === 'cascade.onSecondaryBlock' || path === 'cascade.onSecondaryNonBlock'
    || path === 'cascade.onSecondaryFailure' || path === 'cascade.confirmBlocks'
    || path === 'cascade.retriesPerModel' || path === 'cascade.timeoutMs'
  ) {
    return { role: 'runner', reason: RUNNER_REASON };
  }
  throw new Error(`UNCLASSIFIED_CONFIG:${path}`);
}

export function configLeafPaths(value: unknown = MODEL_CONFIG, prefix = ''): string[] {
  if (Array.isArray(value)) return prefix ? [prefix] : [];
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) =>
      configLeafPaths(child, prefix ? `${prefix}.${key}` : key));
  }
  return prefix ? [prefix] : [];
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, sortValue(record[key])]));
  }
  return value;
}

/** UTF-8 JSON with recursively sorted keys. This is the hashed model configuration. */
export function canonicalModelConfigJson(): string {
  return JSON.stringify(sortValue(MODEL_CONFIG));
}
