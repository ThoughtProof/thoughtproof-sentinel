import type { Document } from './contract.ts';
import { CONFIG_FIELD_ROLE, MODEL_CONFIG } from './model-config.ts';
import { PROMPT_TEMPLATE } from './prompt.ts';

/** Chat message the runner sends unchanged. The first role is always system. */
export interface AdapterMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * OpenServ chat-completions body. `messages` come only from buildAdapterMessages.
 * The runner posts this object as-is and does not merge it into one user message.
 */
export interface AdapterChatRequest {
  model: string;
  temperature: number;
  seed: number;
  max_completion_tokens: number;
  /** OpenAI-compatible form of MODEL_CONFIG.responseFormat. */
  response_format: { type: typeof MODEL_CONFIG.responseFormat };
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

/**
 * Primary nano or block-only secondary swift.
 * Every body-classified config leaf is copied here. Runner-only leaves
 * (endpoint, timeout, retries, cascade policy) are not.
 * Both stages call buildAdapterMessages.
 */
export function buildAdapterRequest(documents: readonly Document[], stage: AdapterStage): AdapterChatRequest {
  if (stage !== 'primary' && stage !== 'secondary') throw new Error('INVALID_STAGE');
  const body: Record<string, unknown> = { messages: buildAdapterMessages(documents) };
  for (const [path, spec] of Object.entries(CONFIG_FIELD_ROLE)) {
    if (spec.role !== 'body') continue;
    if ('stage' in spec && spec.stage !== stage) continue;
    const value = configValue(path);
    if (spec.wire === 'response_format') body.response_format = { type: value };
    else body[spec.wire] = value;
  }
  for (const spec of Object.values(CONFIG_FIELD_ROLE)) {
    if (spec.role !== 'body' || ('stage' in spec && spec.stage !== stage)) continue;
    if (!Object.hasOwn(body, spec.wire)) throw new Error('MISSING_BODY_FIELD');
  }
  return body as unknown as AdapterChatRequest;
}
