/**
 * Pinned model configuration for the offline trade-contract adapter.
 * Nothing in this experiment reads credentials or calls this endpoint.
 * OpenServ accepts `max_completion_tokens` (not `max_tokens`) and honours `seed`.
 * Seed 42 is pot-cli's DEFAULT_EVAL_SEED. Temperature 0 matches that evaluator.
 * max_completion_tokens 4096 and timeoutMs 45000 match the Sentinel standard cascade.
 * This candidate does not retry a model. A failed primary may fall through once
 * to serv-swift. A schema-valid ALLOW, BLOCK, or UNCERTAIN does not fall through.
 */
export const MODEL_CONFIG = {
  provider: 'openserv',
  transport: 'openai-compatible',
  baseUrl: 'https://inference-api.openserv.ai/v1',
  chatPath: '/chat/completions',
  responseFormat: 'json_object',
  primary: {
    model: 'serv-nano',
    temperature: 0,
    seed: 42,
    max_completion_tokens: 4096,
  },
  cascade: {
    secondary: {
      model: 'serv-swift',
      temperature: 0,
      seed: 42,
      max_completion_tokens: 4096,
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
    onSecondaryFailure: 'UNCERTAIN',
    confirmBlocks: false,
    retriesPerModel: 0,
    timeoutMs: 45000,
  },
} as const;

export type CascadeFailure = (typeof MODEL_CONFIG.cascade.when)[number];

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
