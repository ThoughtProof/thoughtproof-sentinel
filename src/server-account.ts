/**
 * ADR-0023 stage 1: server account id from the authenticated key record.
 * Not called from the verify handler. Not a verdict input.
 * A missing or unreadable account record fails closed (HTTP 503).
 * It does not invent an account and it does not produce ALLOW.
 */

export interface ApiKeyRecord {
  key: string;
  platform: string;
  agent_id?: string;
  accountId?: string;
}

export interface ServerAccountLookup {
  /** X-Sentinel-Key value. The only identity this function reads. */
  apiKey: string | undefined;
  /**
   * Caller-supplied account field. Ignored. It must not select the account.
   */
  requestAccountId?: string;
  /**
   * X-Sentinel-Agent-Id. Ignored. It must not select the account.
   */
  agentIdHeader?: string;
  /** Defaults to process.env. Tests pass a fixture. */
  env?: Record<string, unknown>;
}

export type ServerAccountResult =
  | { ok: true; accountId: string }
  | { ok: false; httpStatus: 503; code: 'ACCOUNT_UNAVAILABLE' };

function unavailable(): ServerAccountResult {
  return { ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' };
}

/**
 * Parse SENTINEL_API_KEYS (`key:platform:agent_id` or
 * `key:platform:agent_id:account_id`). Returns null when the value is not
 * a string. The account id is only the explicit account field.
 */
export function parseSentinelApiKeyRecords(raw: unknown): ApiKeyRecord[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const records: ApiKeyRecord[] = [];
    for (const entry of raw.split(',')) {
      if (!entry) continue;
      const parts = entry.trim().split(':');
      const key = parts[0] ?? '';
      const platform = parts[1] ?? 'direct';
      const record: ApiKeyRecord = { key, platform };
      if (parts.length >= 3) record.agent_id = parts[2];
      const accountId = parts.length >= 4 ? parts.slice(3).join(':').trim() : '';
      if (accountId) record.accountId = accountId;
      records.push(record);
    }
    return records;
  } catch {
    return null;
  }
}

/**
 * Stable account id for the key whose record matches `apiKey`.
 * Request fields and X-Sentinel-Agent-Id are not consulted.
 */
export function resolveServerAccountId(input: ServerAccountLookup): ServerAccountResult {
  void input.requestAccountId;
  void input.agentIdHeader;

  let raw: unknown;
  try {
    const env = input.env ?? (process.env as Record<string, unknown>);
    raw = env.SENTINEL_API_KEYS;
  } catch {
    return unavailable();
  }

  const records = parseSentinelApiKeyRecords(raw);
  if (!records || !input.apiKey) return unavailable();

  const matched = records.find((record) => record.key === input.apiKey);
  if (!matched?.accountId) return unavailable();
  return { ok: true, accountId: matched.accountId };
}
