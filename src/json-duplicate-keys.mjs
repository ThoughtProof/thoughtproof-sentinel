/**
 * JSON parse that rejects duplicate keys.
 *
 * Single implementation for the server (src/signed-evidence.ts) and
 * scripts/verify-receipt.mjs. `JSON.parse` keeps the last key, so the same
 * signed bytes can mean two different objects. This module scans the text
 * and treats two keys as the same key after JSON string unescaping
 * (`a` and `\u0061`, including `__proto__`).
 *
 * The scan is iterative. Nesting lives on a heap stack, not the JavaScript
 * call stack, so a deep envelope cannot throw RangeError out of this module.
 * On success the returned value is `JSON.parse(text)`, so numbers, key order,
 * and an own `__proto__` key match the engine that already accepted unique
 * documents. The scanner does not build objects by assignment.
 *
 * If the scan or `JSON.parse` still throws, the result is `json_unexamined`.
 * That is not "no approval". Callers fail the item with that code. Recognition
 * treats the text as an approval when an outer approval claim is present, when
 * a readable top-level `payload` value has an approval shape, or when the text
 * was not examined far enough to rule an approval out. A scan that finishes
 * and finds ordinary invalid JSON stays `json_invalid` and does not by itself
 * mean an approval.
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
export const JSON_UNEXAMINED = 'json_unexamined';

/**
 * @param {string} text
 * @returns
 *   | { ok: true, value: unknown, payloadValues: unknown[] }
 *   | { ok: false, code: 'duplicate_json_key', value: unknown, payloadValues: unknown[] }
 *   | { ok: false, code: 'json_invalid' }
 *   | { ok: false, code: 'json_unexamined', payloadValues?: unknown[] }
 */
export function parseJsonText(text) {
  if (typeof text !== 'string') return { ok: false, code: 'json_invalid' };

  let scan;
  try {
    scan = scanJson(text);
  } catch {
    return { ok: false, code: JSON_UNEXAMINED };
  }
  if (!scan.valid) return { ok: false, code: 'json_invalid' };

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: JSON_UNEXAMINED, payloadValues: readPayloadSlices(scan.payloadSlices) };
  }

  const payloadValues = readPayloadSlices(scan.payloadSlices);
  if (payloadValues === null) return { ok: false, code: JSON_UNEXAMINED };

  if (scan.duplicate) {
    return { ok: false, code: DUPLICATE_JSON_KEY, value, payloadValues };
  }
  return { ok: true, value, payloadValues };
}

/**
 * @param {string[]} slices
 * @returns {unknown[] | null} null when a slice cannot be parsed
 */
function readPayloadSlices(slices) {
  /** @type {unknown[]} */
  const payloadValues = [];
  for (const slice of slices) {
    try {
      payloadValues.push(JSON.parse(slice));
    } catch {
      return null;
    }
  }
  return payloadValues;
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
  /** @type {Array<Record<string, unknown>>} */
  const stack = [{ kind: 'top', phase: 'value' }];

  const invalid = () => ({ valid: false, duplicate: false, payloadSlices: [] });

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    if (frame.kind === 'top') {
      if (frame.phase === 'value') {
        const started = beginValue(true);
        if (started === 'bad') return invalid();
        frame.phase = started === 'container' ? 'wait' : 'end';
        continue;
      }
      if (frame.phase === 'wait') {
        frame.phase = 'end';
        continue;
      }
      skipWs();
      if (i !== text.length) return invalid();
      stack.pop();
      continue;
    }

    if (frame.kind === 'object') {
      if (frame.phase === 'key') {
        skipWs();
        if (text[i] !== '"') return invalid();
        const key = readString();
        if (key === null) return invalid();
        const seen = /** @type {Set<string>} */ (frame.seen);
        if (seen.has(key)) duplicate = true;
        else seen.add(key);
        frame.key = key;
        frame.phase = 'colon';
        continue;
      }
      if (frame.phase === 'colon') {
        skipWs();
        if (text[i] !== ':') return invalid();
        i += 1;
        frame.valueStart = i;
        frame.phase = 'value';
        continue;
      }
      if (frame.phase === 'value') {
        const started = beginValue(false);
        if (started === 'bad') return invalid();
        if (started === 'container') {
          frame.phase = 'wait';
          continue;
        }
        closeObjectValue(frame);
        continue;
      }
      if (frame.phase === 'wait') {
        closeObjectValue(frame);
        continue;
      }
      skipWs();
      if (text[i] === ',') {
        i += 1;
        frame.phase = 'key';
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        stack.pop();
        continue;
      }
      return invalid();
    }

    if (frame.phase === 'value') {
      const started = beginValue(false);
      if (started === 'bad') return invalid();
      if (started === 'container') {
        frame.phase = 'wait';
        continue;
      }
      frame.phase = 'after';
      continue;
    }
    if (frame.phase === 'wait') {
      frame.phase = 'after';
      continue;
    }
    skipWs();
    if (text[i] === ',') {
      i += 1;
      frame.phase = 'value';
      continue;
    }
    if (text[i] === ']') {
      i += 1;
      stack.pop();
      continue;
    }
    return invalid();
  }

  return { valid: true, duplicate, payloadSlices };

  function skipWs() {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) break;
      i += 1;
    }
  }

  /** @param {boolean} isRoot */
  function beginValue(isRoot) {
    skipWs();
    if (i >= text.length) return 'bad';
    const c = text[i];
    if (c === '{') {
      i += 1;
      skipWs();
      if (text[i] === '}') {
        i += 1;
        return 'atom';
      }
      stack.push({
        kind: 'object',
        isRoot,
        phase: 'key',
        seen: new Set(),
        key: null,
        valueStart: 0,
      });
      return 'container';
    }
    if (c === '[') {
      i += 1;
      skipWs();
      if (text[i] === ']') {
        i += 1;
        return 'atom';
      }
      stack.push({ kind: 'array', phase: 'value' });
      return 'container';
    }
    if (c === '"') return readString() === null ? 'bad' : 'atom';
    if (c === 't') return consume('true') ? 'atom' : 'bad';
    if (c === 'f') return consume('false') ? 'atom' : 'bad';
    if (c === 'n') return consume('null') ? 'atom' : 'bad';
    if (c === '-' || (c >= '0' && c <= '9')) return readNumber() ? 'atom' : 'bad';
    return 'bad';
  }

  /** @param {Record<string, unknown>} frame */
  function closeObjectValue(frame) {
    if (frame.isRoot === true && frame.key === 'payload') {
      payloadSlices.push(text.slice(/** @type {number} */ (frame.valueStart), i));
    }
    frame.phase = 'after';
  }

  /** @returns {string | null} */
  function readString() {
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

  function readNumber() {
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
