/**
 * JSON parse that rejects duplicate keys.
 *
 * Single implementation for the server (src/signed-evidence.ts) and
 * scripts/verify-receipt.mjs. `JSON.parse` keeps the last key, so the same
 * signed bytes can mean two different objects. This module scans the text
 * and treats two keys as the same key after JSON string unescaping
 * (`a` and `\u0061`, including `__proto__`).
 *
 * On success the returned value is `JSON.parse(text)`, so numbers, key order,
 * and an own `__proto__` key match the engine that already accepted unique
 * documents. The scanner does not build objects by assignment.
 *
 * `payloadValues` is every top-level value of the key `payload`, in order,
 * each parsed with `JSON.parse` on its own slice. Callers use that to see an
 * approval shape that a last-key parse would drop. Nested objects are still
 * covered by the duplicate scan; only the raw-event envelope's `payload`
 * key is collected.
 *
 * The HTTP request body is not parsed here. The server does not see those
 * original bytes.
 */

export const DUPLICATE_JSON_KEY = 'duplicate_json_key';

/**
 * @param {string} text
 * @returns
 *   | { ok: true, value: unknown, payloadValues: unknown[] }
 *   | { ok: false, code: 'duplicate_json_key', value: unknown, payloadValues: unknown[] }
 *   | { ok: false, code: 'json_invalid' }
 */
export function parseJsonText(text) {
  if (typeof text !== 'string') return { ok: false, code: 'json_invalid' };
  const scan = scanJson(text);
  if (!scan.valid) return { ok: false, code: 'json_invalid' };

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'json_invalid' };
  }

  /** @type {unknown[]} */
  const payloadValues = [];
  for (const slice of scan.payloadSlices) {
    try {
      payloadValues.push(JSON.parse(slice));
    } catch {
      return { ok: false, code: 'json_invalid' };
    }
  }

  if (scan.duplicate) {
    return { ok: false, code: DUPLICATE_JSON_KEY, value, payloadValues };
  }
  return { ok: true, value, payloadValues };
}

/**
 * @param {string} text
 * @returns {{ valid: boolean, duplicate: boolean, payloadSlices: string[] }}
 */
function scanJson(text) {
  let i = 0;
  let duplicate = false;
  /** @type {string[]} */
  const payloadSlices = [];

  const valid = parseRoot();
  skipWs();
  if (!valid || i !== text.length) {
    return { valid: false, duplicate: false, payloadSlices: [] };
  }
  return { valid: true, duplicate, payloadSlices };

  function skipWs() {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) break;
      i += 1;
    }
  }

  function parseRoot() {
    skipWs();
    if (i >= text.length) return false;
    if (text[i] === '{') return parseObject(true);
    return parseValue();
  }

  function parseValue() {
    skipWs();
    if (i >= text.length) return false;
    const c = text[i];
    if (c === '{') return parseObject(false);
    if (c === '[') return parseArray();
    if (c === '"') return parseString() !== null;
    if (c === 't') return consume('true');
    if (c === 'f') return consume('false');
    if (c === 'n') return consume('null');
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    return false;
  }

  function parseObject(isRoot) {
    i += 1;
    skipWs();
    if (text[i] === '}') {
      i += 1;
      return true;
    }
    const seen = new Set();
    while (i < text.length) {
      skipWs();
      if (text[i] !== '"') return false;
      const key = parseString();
      if (key === null) return false;
      if (seen.has(key)) duplicate = true;
      else seen.add(key);
      skipWs();
      if (text[i] !== ':') return false;
      i += 1;
      const valueStart = i;
      if (!parseValue()) return false;
      if (isRoot && key === 'payload') payloadSlices.push(text.slice(valueStart, i));
      skipWs();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return true;
      }
      return false;
    }
    return false;
  }

  function parseArray() {
    i += 1;
    skipWs();
    if (text[i] === ']') {
      i += 1;
      return true;
    }
    while (i < text.length) {
      if (!parseValue()) return false;
      skipWs();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === ']') {
        i += 1;
        return true;
      }
      return false;
    }
    return false;
  }

  /** @returns {string | null} */
  function parseString() {
    if (text[i] !== '"') return null;
    i += 1;
    let out = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i += 1;
        return out;
      }
      if (c === '\\') {
        i += 1;
        if (i >= text.length) return null;
        const esc = text[i];
        i += 1;
        if (esc === '"' || esc === '\\' || esc === '/') {
          out += esc;
          continue;
        }
        if (esc === 'b') {
          out += '\b';
          continue;
        }
        if (esc === 'f') {
          out += '\f';
          continue;
        }
        if (esc === 'n') {
          out += '\n';
          continue;
        }
        if (esc === 'r') {
          out += '\r';
          continue;
        }
        if (esc === 't') {
          out += '\t';
          continue;
        }
        if (esc === 'u') {
          if (i + 4 > text.length) return null;
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          i += 4;
          out += String.fromCharCode(Number.parseInt(hex, 16));
          continue;
        }
        return null;
      }
      if (c.charCodeAt(0) <= 0x1f) return null;
      out += c;
      i += 1;
    }
    return null;
  }

  function parseNumber() {
    const start = i;
    if (text[i] === '-') i += 1;
    if (i >= text.length || text[i] < '0' || text[i] > '9') return false;
    if (text[i] === '0') {
      i += 1;
    } else {
      while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
    }
    if (text[i] === '.') {
      i += 1;
      const frac = i;
      while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
      if (i === frac) return false;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i += 1;
      if (text[i] === '+' || text[i] === '-') i += 1;
      const exp = i;
      while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
      if (i === exp) return false;
    }
    return i > start;
  }

  function consume(word) {
    if (!text.startsWith(word, i)) return false;
    i += word.length;
    return true;
  }
}
