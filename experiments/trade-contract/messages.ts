import type { Document } from './contract.ts';
import { classifyConfigPath, configLeafPaths, MODEL_CONFIG, XAI_CHAT_COMPLETIONS_URL } from './model-config.ts';
import { PROMPT_TEMPLATE } from './prompt.ts';
import { VERDICT_SCHEMA, VERDICT_SCHEMA_ID } from './verdict-schema.ts';

export { XAI_CHAT_COMPLETIONS_URL };

/** Chat message the runner sends unchanged. The first role is always system. */
export interface AdapterMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * xAI chat-completions body. The runner POSTs this object unchanged.
 * `messages` come only from buildAdapterMessages.
 */
export interface AdapterChatRequest {
  model: string;
  temperature: number;
  seed: number;
  max_completion_tokens: number;
  response_format: {
    type: 'json_schema';
    json_schema: {
      name: string;
      strict: true;
      schema: typeof VERDICT_SCHEMA;
    };
  };
  messages: AdapterMessage[];
}

export type AdapterStage = 'primary' | 'secondary';

function isDocument(value: unknown): value is Document {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 256
    && (row.role === 'proposal' || row.role === 'source')
    && typeof row.text === 'string' && row.text.length <= 2_000_000;
}

/**
 * Exact messages for one review. System text is the frozen prompt.
 * The user message is the JSON document array and therefore ends with that array.
 * Invalid documents throw; they never become a releasable request.
 */
export function buildAdapterMessages(documents: readonly Document[]): AdapterMessage[] {
  if (!Array.isArray(documents) || documents.length === 0 || documents.length > 1_024
    || !documents.every(isDocument)) {
    throw new Error('INVALID_DOCUMENTS');
  }
  if (documents.filter(document => document.role === 'proposal').length !== 1) throw new Error('INVALID_DOCUMENTS');
  if (new Set(documents.map(document => document.id)).size !== documents.length) throw new Error('INVALID_DOCUMENTS');
  const payload = documents.map(document => ({ id: document.id, role: document.role, text: document.text }));
  return [
    { role: 'system', content: PROMPT_TEMPLATE },
    { role: 'user', content: JSON.stringify(payload) },
  ];
}

function configValue(path: string): unknown {
  let current: unknown = MODEL_CONFIG;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') throw new Error('MISSING_CONFIG');
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function responseFormatBody(): AdapterChatRequest['response_format'] {
  if (MODEL_CONFIG.responseFormat.schemaId !== VERDICT_SCHEMA_ID) throw new Error('SCHEMA_ID_MISMATCH');
  if (XAI_CHAT_COMPLETIONS_URL !== `${MODEL_CONFIG.baseUrl}${MODEL_CONFIG.chatPath}`) {
    throw new Error('ENDPOINT_MISMATCH');
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: MODEL_CONFIG.responseFormat.name,
      strict: true,
      schema: VERDICT_SCHEMA,
    },
  };
}

/**
 * Primary grok-4.7 or block-only secondary grok-4.3.
 * Every body-classified config leaf is copied. Runner leaves (endpoint,
 * prices, timeout, retries, cascade policy) are not. Both stages call
 * buildAdapterMessages. No OpenServ field is included.
 */
export function buildAdapterRequest(documents: readonly Document[], stage: AdapterStage): AdapterChatRequest {
  if (stage !== 'primary' && stage !== 'secondary') throw new Error('INVALID_STAGE');
  const body: Record<string, unknown> = { messages: buildAdapterMessages(documents) };
  for (const path of configLeafPaths()) {
    const spec = classifyConfigPath(path);
    if (spec.role !== 'body' || (spec.stage !== undefined && spec.stage !== stage)) continue;
    if (spec.wire === 'response_format') body.response_format = responseFormatBody();
    else body[spec.wire] = configValue(path);
  }
  for (const path of configLeafPaths()) {
    const spec = classifyConfigPath(path);
    if (spec.role !== 'body' || (spec.stage !== undefined && spec.stage !== stage)) continue;
    if (!Object.hasOwn(body, spec.wire)) throw new Error('MISSING_BODY_FIELD');
  }
  return body as unknown as AdapterChatRequest;
}
