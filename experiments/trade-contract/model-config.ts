/**
 * Pinned model configuration for the offline trade-contract adapter.
 * Nothing in this experiment reads credentials or calls this endpoint.
 * OpenServ accepts `max_completion_tokens` (not `max_tokens`) and honours `seed`.
 * Seed 42 is pot-cli's DEFAULT_EVAL_SEED. Temperature 0 matches that evaluator.
 * max_completion_tokens 4096 and timeoutMs 45000 match the Sentinel standard cascade.
 * This candidate does not retry a model. A failed primary may fall through once
 * to serv-swift. A schema-valid primary decision does not fall through.
 * On that fall-through, serv-swift is block-only: BLOCK stays BLOCK, and
 * ALLOW, CONDITIONAL_ALLOW, HOLD, UNCERTAIN, or any other non-BLOCK outcome
 * becomes UNCERTAIN. If serv-swift also fails, the result is UNCERTAIN.
 *
 * `buildAdapterRequest` copies every `body` leaf below into the chat-completions
 * JSON. `runner` leaves are not body fields: the runner or this adapter applies
 * them (endpoint URL, timeout, retries, and the block-only cascade policy).
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
    /** Swift may publish only BLOCK. Every other outcome, including failure, is UNCERTAIN. */
    secondaryPolicy: 'block_only',
    onSecondaryBlock: 'BLOCK',
    onSecondaryNonBlock: 'UNCERTAIN',
    onSecondaryFailure: 'UNCERTAIN',
    confirmBlocks: false,
    retriesPerModel: 0,
    timeoutMs: 45000,
  },
} as const;

export type CascadeFailure = (typeof MODEL_CONFIG.cascade.when)[number];

type BodyField = { role: 'body'; wire: string; stage?: 'primary' | 'secondary' };
type RunnerField = { role: 'runner'; reason: string };

/**
 * Complete partition of every leaf in MODEL_CONFIG.
 * A new config leaf must be classified here or the audit test fails.
 * `responseFormat` is sent as OpenAI-compatible `response_format: { type }`.
 */
export const CONFIG_FIELD_ROLE = {
  provider: { role: 'runner', reason: 'Provider name. The runner selects the client. Not a JSON body field.' },
  transport: { role: 'runner', reason: 'Wire protocol. Not a JSON body field.' },
  baseUrl: { role: 'runner', reason: 'Endpoint URL. Not a JSON body field.' },
  chatPath: { role: 'runner', reason: 'Endpoint path. Not a JSON body field.' },
  responseFormat: { role: 'body', wire: 'response_format' },
  'primary.model': { role: 'body', wire: 'model', stage: 'primary' },
  'primary.temperature': { role: 'body', wire: 'temperature', stage: 'primary' },
  'primary.seed': { role: 'body', wire: 'seed', stage: 'primary' },
  'primary.max_completion_tokens': { role: 'body', wire: 'max_completion_tokens', stage: 'primary' },
  'cascade.secondary.model': { role: 'body', wire: 'model', stage: 'secondary' },
  'cascade.secondary.temperature': { role: 'body', wire: 'temperature', stage: 'secondary' },
  'cascade.secondary.seed': { role: 'body', wire: 'seed', stage: 'secondary' },
  'cascade.secondary.max_completion_tokens': { role: 'body', wire: 'max_completion_tokens', stage: 'secondary' },
  'cascade.when': { role: 'runner', reason: 'When the adapter may call swift. Not a JSON body field.' },
  'cascade.secondaryPolicy': { role: 'runner', reason: 'Block-only publication rule. Not a JSON body field.' },
  'cascade.onSecondaryBlock': { role: 'runner', reason: 'Adapter keeps a swift BLOCK. Not a JSON body field.' },
  'cascade.onSecondaryNonBlock': { role: 'runner', reason: 'Adapter withholds every non-BLOCK swift outcome. Not a JSON body field.' },
  'cascade.onSecondaryFailure': { role: 'runner', reason: 'Adapter result when swift fails. Not a JSON body field.' },
  'cascade.confirmBlocks': { role: 'runner', reason: 'No extra confirm call. Not a JSON body field.' },
  'cascade.retriesPerModel': { role: 'runner', reason: 'Runner retry count. Not a JSON body field.' },
  'cascade.timeoutMs': { role: 'runner', reason: 'Runner timeout. Not a JSON body field.' },
} as const satisfies Record<string, BodyField | RunnerField>;

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
