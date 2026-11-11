export const DUPLICATE_JSON_KEY: 'duplicate_json_key';
export const JSON_UNEXAMINED: 'json_unexamined';

export type JsonTextParse =
  | { ok: true; value: unknown; payloadValues: unknown[] }
  | {
      ok: false;
      code: 'duplicate_json_key';
      value: unknown;
      payloadValues: unknown[];
    }
  | { ok: false; code: 'json_invalid' }
  | { ok: false; code: 'json_unexamined'; payloadValues?: unknown[] };

export function parseJsonText(text: string): JsonTextParse;
