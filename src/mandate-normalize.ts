/**
 * ADR-0023 stage-4 prerequisite: one mandate normalization.
 * Not a verdict by itself. The request-path module is the only caller,
 * and only when enforcement is on.
 * A failed check is BLOCK. Success is a concrete normalized mandate.
 * It is not ALLOW, and a verified signature does not make it ALLOW.
 *
 * Stage 3 does not call this. `principalMandateSignedBytes` still signs
 * the object it is given. Stage 4 must sign and verify `canonicalJson`
 * from this module, not the pre-normalization object.
 *
 * Offsets are UTF-16 indexes into the original text. This module does
 * not lowercase that text: Unicode case folding can expand a character
 * (U+0130) and move an index.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - canonicalize types are loose; runtime export is the function
import canonicalize from 'canonicalize';

/** Contract version. Not a field of the canonical mandate. */
export const MANDATE_NORMALIZATION_VERSION = 'sentinel.mandate.normalized.v1';

/** Original text and canonical JSON, UTF-8 bytes. */
export const MANDATE_MAX_UTF8_BYTES = 8192;

/** One string field, UTF-8 bytes. */
export const MANDATE_MAX_STRING_UTF8_BYTES = 512;

/** Own keys on one object. */
export const MANDATE_MAX_KEYS = 16;

/**
 * Object levels that are in the shape: the mandate, then `granted` or
 * `action`. A value inside those objects is a scalar. A further object
 * is malformed.
 */
export const MANDATE_MAX_DEPTH = 2;

/** Scanner safety bound. Deeper input is malformed and is not walked further. */
const SCAN_MAX_DEPTH = 8;

const CONCRETE_KINDS = ['informational', 'value_transfer', 'permission', 'deploy_ship'] as const;

export type ConcreteActionKind = (typeof CONCRETE_KINDS)[number];

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const TOP_KEYS = new Set(['kind', 'granted', 'action']);

const GRANTED_KEYS = new Set([
  'maxAmount',
  'maxAmountUsd',
  'max_amount',
  'asset',
  'recipient',
  'allowUnlimited',
]);

const TRANSFER_ACTION_KEYS = new Set([
  'kind',
  'amount',
  'amountUsd',
  'amount_usd',
  'asset',
  'recipient',
]);

const PERMISSION_ACTION_KEYS = new Set([
  'kind',
  'allowance',
  'amount',
  'amountUsd',
  'amount_usd',
  'asset',
  'recipient',
]);

const INFORMATIONAL_ACTION_KEYS = new Set(['kind', 'content', 'recipient']);

const DEPLOY_SHIP_ACTION_KEYS = new Set(['kind', 'target', 'revision']);

/**
 * Execution-relevant fields. A missing one is not a bound action.
 * Permission's spender is `recipient`, the field the authorization gate
 * already reads. Mandate `kind` is not required to equal `action.kind`.
 */
export const ACTION_REQUIRED_FIELDS = {
  value_transfer: ['amount', 'asset', 'recipient'],
  permission: ['allowance', 'asset', 'recipient'],
  informational: ['content', 'recipient'],
  deploy_ship: ['target', 'revision'],
} as const;

/**
 * Bounded allowance: a non-negative decimal integer. No sign, whitespace,
 * exponent, decimal point, or leading zeros. `0` is the only zero form.
 */
export const CANONICAL_ALLOWANCE_PATTERN = /^(0|[1-9][0-9]*)$/;

/** The only unlimited allowance. Other spellings are malformed. */
export const CANONICAL_UNLIMITED_ALLOWANCE = 'unlimited';

export interface NormalizedGranted {
  maxAmount?: number;
  asset?: string;
  recipient?: string;
  allowUnlimited?: boolean;
}

export interface NormalizedAction {
  kind: ConcreteActionKind;
  amount?: number;
  asset?: string;
  /** Payee for a transfer, audience for informational, spender for permission. */
  recipient?: string;
  /** Canonical integer string, or exactly `unlimited`. */
  allowance?: string;
  content?: string;
  /** Deployment target for `deploy_ship`. */
  target?: string;
  /** Revision, tag, or commit for `deploy_ship`. */
  revision?: string;
}

export interface NormalizedMandate {
  /** Preserved when the caller sent a supported kind. Not copied from `action`. */
  kind?: ConcreteActionKind;
  granted?: NormalizedGranted;
  action: NormalizedAction;
}

export type MandateBlockReason =
  | 'not_object'
  | 'empty'
  | 'action_missing'
  | 'action_not_concrete'
  | 'unknown_field'
  | 'malformed'
  | 'alias_conflict'
  | 'prototype_key'
  | 'too_large';

export type MandateGateVerdict = 'ALLOW' | 'BLOCK' | 'UNCERTAIN';

export interface MandateTextSpan {
  /** Index of the opening quote of the key in the original text. */
  start: number;
  /** Index just after the closing quote of the key. */
  end: number;
}

export type MandateNormalizeResult =
  | {
      ok: true;
      mandate: NormalizedMandate;
      /** JCS of `mandate`. The signer, the gate, and the digest share this. */
      canonicalJson: string;
      canonicalBytes: number;
      /** Present when the input was original JSON text. */
      spans?: { action: MandateTextSpan };
    }
  | {
      ok: false;
      verdict: 'BLOCK';
      reason: MandateBlockReason;
      /**
       * UTF-16 index into the original text. Omitted when the input was
       * not a string. Never an index into a lowercased copy.
       */
      offset?: number;
    };

interface KeyHit {
  key: string;
  offset: number;
  end: number;
  depth: number;
  parent: string | null;
}

interface ScanOk {
  ok: true;
  hits: KeyHit[];
}

interface ScanFail {
  ok: false;
  offset: number;
}

function block(reason: MandateBlockReason, offset?: number): MandateNormalizeResult {
  if (offset === undefined) return { ok: false, verdict: 'BLOCK', reason };
  return { ok: false, verdict: 'BLOCK', reason, offset };
}

function jcs(value: unknown): string | null {
  try {
    const out = (canonicalize as (input: unknown) => string | undefined)(value);
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isConcreteKind(value: unknown): value is ConcreteActionKind {
  return (
    value === 'informational' ||
    value === 'value_transfer' ||
    value === 'permission' ||
    value === 'deploy_ship'
  );
}

/** Finite, non-negative, and stable through JSON. `-0` is rejected. */
function isCanonicalNumber(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (Object.is(value, -0) || value < 0) return false;
  return (JSON.parse(JSON.stringify(value)) as unknown) === value;
}

/**
 * Trimmed identity. Blank and whitespace-only values are not identities.
 * The canonical text is the trimmed string. Case is unchanged.
 */
function canonicalIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || hasLoneSurrogate(value)) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || utf8Bytes(trimmed) > MANDATE_MAX_STRING_UTF8_BYTES) return null;
  return trimmed;
}

/**
 * One allowance grammar. A safe non-negative integer number becomes its
 * decimal string. A decimal string that matches the grammar is kept
 * unchanged. A string `Number` cannot represent as a finite value is
 * unparseable: the gate would skip `unlimited_approval` as
 * `allowance_unparseable`. `unlimited` is the only non-numeric token.
 */
function canonicalAllowance(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!isCanonicalNumber(value) || !Number.isSafeInteger(value)) return null;
    const text = String(value);
    return CANONICAL_ALLOWANCE_PATTERN.test(text) ? text : null;
  }
  if (typeof value !== 'string' || hasLoneSurrogate(value)) return null;
  if (value === CANONICAL_UNLIMITED_ALLOWANCE) return value;
  if (
    CANONICAL_ALLOWANCE_PATTERN.test(value) &&
    utf8Bytes(value) <= MANDATE_MAX_STRING_UTF8_BYTES &&
    Number.isFinite(Number(value))
  ) {
    return value;
  }
  return null;
}

function hitOffset(hits: KeyHit[] | null, key: string, parent: string | null): number | undefined {
  if (!hits) return undefined;
  const found = hits.find((hit) => hit.key === key && hit.parent === parent);
  return found?.offset;
}

function actionSpan(hits: KeyHit[] | null): { action: MandateTextSpan } | undefined {
  if (!hits) return undefined;
  const found = hits.find((hit) => hit.key === 'action' && hit.parent === null && hit.depth === 0);
  if (!found) return undefined;
  return { action: { start: found.offset, end: found.end } };
}

/**
 * One forward scan of the original text. Key offsets are indexes into
 * `text`. The scan does not build a lowercased copy.
 */
function scanMandateText(text: string): ScanOk | ScanFail {
  const n = text.length;
  let i = 0;
  let recorded: number | null = null;
  const hits: KeyHit[] = [];
  let currentParent: string | null = null;

  const fail = (): ScanFail => ({ ok: false, offset: recorded ?? i });

  const mark = (offset: number): false => {
    if (recorded === null) recorded = offset;
    return false;
  };

  const skipWs = (): void => {
    while (i < n) {
      const code = text.charCodeAt(i);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      i++;
    }
  };

  const parseString = (): { value: string; offset: number; end: number } | null => {
    if (text[i] !== '"') return null;
    const offset = i;
    i++;
    let value = '';
    while (i < n) {
      const code = text.charCodeAt(i);
      if (text[i] === '"') {
        i++;
        return { value, offset, end: i };
      }
      if (code < 0x20) return null;
      if (text[i] !== '\\') {
        value += text[i];
        i++;
        continue;
      }
      i++;
      if (i >= n) return null;
      const esc = text[i];
      if (esc === '"' || esc === '\\' || esc === '/') {
        value += esc;
        i++;
        continue;
      }
      if (esc === 'b') {
        value += '\b';
        i++;
        continue;
      }
      if (esc === 'f') {
        value += '\f';
        i++;
        continue;
      }
      if (esc === 'n') {
        value += '\n';
        i++;
        continue;
      }
      if (esc === 'r') {
        value += '\r';
        i++;
        continue;
      }
      if (esc === 't') {
        value += '\t';
        i++;
        continue;
      }
      if (esc === 'u') {
        const hex = text.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        const decoded = String.fromCharCode(parseInt(hex, 16));
        value += decoded;
        i += 5;
        continue;
      }
      return null;
    }
    return null;
  };

  const consumeLiteral = (word: string): boolean => {
    if (!text.startsWith(word, i)) return false;
    const after = text.charCodeAt(i + word.length);
    if (
      after === after &&
      ((after >= 0x30 && after <= 0x39) ||
        (after >= 0x41 && after <= 0x5a) ||
        (after >= 0x61 && after <= 0x7a) ||
        after === 0x5f)
    ) {
      return false;
    }
    i += word.length;
    return true;
  };

  const consumeNumber = (): boolean => {
    const start = i;
    if (text[i] === '-') i++;
    if (i >= n) return false;
    if (text[i] === '0') {
      i++;
    } else if (text.charCodeAt(i) >= 0x31 && text.charCodeAt(i) <= 0x39) {
      while (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++;
    } else {
      return false;
    }
    if (text[i] === '.') {
      i++;
      const frac = i;
      while (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++;
      if (i === frac) return false;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      const exp = i;
      while (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++;
      if (i === exp) return false;
    }
    return i > start;
  };

  const parseValue = (depth: number): boolean => {
    if (depth > SCAN_MAX_DEPTH) return mark(i);
    skipWs();
    if (i >= n) return false;
    const c = text[i];
    if (c === '"') return parseString() !== null;
    if (c === '{') return parseObject(depth);
    if (c === '[') return parseArray(depth);
    if (c === 't') return consumeLiteral('true');
    if (c === 'f') return consumeLiteral('false');
    if (c === 'n') return consumeLiteral('null');
    if (c === '-' || (text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39)) {
      return consumeNumber();
    }
    return false;
  };

  const parseArray = (depth: number): boolean => {
    i++;
    skipWs();
    if (text[i] === ']') {
      i++;
      return true;
    }
    while (i < n) {
      if (!parseValue(depth + 1)) return false;
      skipWs();
      if (text[i] === ']') {
        i++;
        return true;
      }
      if (text[i] !== ',') return false;
      i++;
    }
    return false;
  };

  const parseObject = (depth: number): boolean => {
    const parent = currentParent;
    i++;
    const seen = new Set<string>();
    skipWs();
    if (text[i] === '}') {
      i++;
      return true;
    }
    while (i < n) {
      if (text[i] !== '"') return false;
      const key = parseString();
      if (!key) return false;
      if (seen.has(key.value)) return mark(key.offset);
      seen.add(key.value);
      hits.push({
        key: key.value,
        offset: key.offset,
        end: key.end,
        depth,
        parent,
      });
      skipWs();
      if (text[i] !== ':') return false;
      i++;
      const savedParent = currentParent;
      currentParent = key.value;
      const valueOk = parseValue(depth + 1);
      currentParent = savedParent;
      if (!valueOk) return false;
      skipWs();
      if (text[i] === '}') {
        i++;
        return true;
      }
      if (text[i] !== ',') return false;
      i++;
      skipWs();
    }
    return false;
  };

  skipWs();
  if (i >= n || !parseValue(0)) return fail();
  skipWs();
  if (i !== n) return fail();
  return { ok: true, hits };
}

type AliasNumber = { ok: true; value: number | undefined } | { ok: false; result: MandateNormalizeResult };

function readAliasNumber(
  source: Record<string, unknown>,
  canonical: string,
  aliases: readonly string[],
  hits: KeyHit[] | null,
  parent: string | null,
): AliasNumber {
  const present: { key: string; value: number }[] = [];
  const keys = [canonical, ...aliases];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const raw = source[key];
    if (!isCanonicalNumber(raw)) {
      return { ok: false, result: block('malformed', hitOffset(hits, key, parent)) };
    }
    present.push({ key, value: raw });
  }
  if (present.length === 0) return { ok: true, value: undefined };
  const first = present[0];
  if (!first) return { ok: true, value: undefined };
  for (const item of present) {
    if (item.value !== first.value) {
      return { ok: false, result: block('alias_conflict', hitOffset(hits, item.key, parent)) };
    }
  }
  return { ok: true, value: first.value };
}

function rejectBadKey(
  name: string,
  allowed: Set<string>,
  hits: KeyHit[] | null,
  parent: string | null,
): MandateNormalizeResult | null {
  if (PROTOTYPE_KEYS.has(name)) return block('prototype_key', hitOffset(hits, name, parent));
  if (!allowed.has(name)) return block('unknown_field', hitOffset(hits, name, parent));
  return null;
}

function parseGranted(
  value: unknown,
  hits: KeyHit[] | null,
): { ok: true; granted: NormalizedGranted } | { ok: false; result: MandateNormalizeResult } {
  if (!isPlainObject(value)) return { ok: false, result: block('malformed', hitOffset(hits, 'granted', null)) };
  const names = Object.getOwnPropertyNames(value);
  if (names.length === 0) {
    return { ok: false, result: block('malformed', hitOffset(hits, 'granted', null)) };
  }
  if (names.length > MANDATE_MAX_KEYS) {
    return { ok: false, result: block('too_large', hitOffset(hits, names[MANDATE_MAX_KEYS] ?? 'granted', 'granted')) };
  }
  for (const name of names) {
    const bad = rejectBadKey(name, GRANTED_KEYS, hits, 'granted');
    if (bad) return { ok: false, result: bad };
  }
  const amount = readAliasNumber(value, 'maxAmount', ['maxAmountUsd', 'max_amount'], hits, 'granted');
  if (!amount.ok) return amount;
  let asset: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'asset')) {
    const identity = canonicalIdentity(value.asset);
    if (identity == null) {
      return { ok: false, result: block('malformed', hitOffset(hits, 'asset', 'granted')) };
    }
    asset = identity;
  }
  let recipient: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'recipient')) {
    const identity = canonicalIdentity(value.recipient);
    if (identity == null) {
      return { ok: false, result: block('malformed', hitOffset(hits, 'recipient', 'granted')) };
    }
    recipient = identity;
  }
  let allowUnlimited: boolean | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'allowUnlimited')) {
    if (typeof value.allowUnlimited !== 'boolean') {
      return { ok: false, result: block('malformed', hitOffset(hits, 'allowUnlimited', 'granted')) };
    }
    allowUnlimited = value.allowUnlimited;
  }
  const granted: NormalizedGranted = {};
  if (amount.value !== undefined) granted.maxAmount = amount.value;
  if (asset !== undefined) granted.asset = asset;
  if (recipient !== undefined) granted.recipient = recipient;
  if (allowUnlimited !== undefined) granted.allowUnlimited = allowUnlimited;
  if (Object.keys(granted).length === 0) {
    return { ok: false, result: block('malformed', hitOffset(hits, 'granted', null)) };
  }
  return { ok: true, granted };
}

function actionKeysFor(kind: ConcreteActionKind): Set<string> {
  if (kind === 'value_transfer') return TRANSFER_ACTION_KEYS;
  if (kind === 'permission') return PERMISSION_ACTION_KEYS;
  if (kind === 'informational') return INFORMATIONAL_ACTION_KEYS;
  return DEPLOY_SHIP_ACTION_KEYS;
}

function parseAction(
  value: unknown,
  hits: KeyHit[] | null,
): { ok: true; action: NormalizedAction } | { ok: false; result: MandateNormalizeResult } {
  if (!isPlainObject(value)) {
    return { ok: false, result: block('action_not_concrete', hitOffset(hits, 'action', null)) };
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length === 0) {
    return { ok: false, result: block('action_not_concrete', hitOffset(hits, 'action', null)) };
  }
  if (names.length > MANDATE_MAX_KEYS) {
    return { ok: false, result: block('too_large', hitOffset(hits, names[MANDATE_MAX_KEYS] ?? 'action', 'action')) };
  }
  for (const name of names) {
    if (PROTOTYPE_KEYS.has(name)) {
      return { ok: false, result: block('prototype_key', hitOffset(hits, name, 'action')) };
    }
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'kind') || !isConcreteKind(value.kind)) {
    return { ok: false, result: block('action_not_concrete', hitOffset(hits, 'action', null)) };
  }
  const kind = value.kind;
  const allowed = actionKeysFor(kind);
  for (const name of names) {
    if (!allowed.has(name)) {
      return { ok: false, result: block('unknown_field', hitOffset(hits, name, 'action')) };
    }
  }
  const amount = readAliasNumber(value, 'amount', ['amountUsd', 'amount_usd'], hits, 'action');
  if (!amount.ok) return amount;

  let asset: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'asset')) {
    const identity = canonicalIdentity(value.asset);
    if (identity == null) {
      return { ok: false, result: block('malformed', hitOffset(hits, 'asset', 'action')) };
    }
    asset = identity;
  }
  let recipient: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'recipient')) {
    const identity = canonicalIdentity(value.recipient);
    if (identity == null) {
      return { ok: false, result: block('malformed', hitOffset(hits, 'recipient', 'action')) };
    }
    recipient = identity;
  }
  let content: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'content')) {
    const identity = canonicalIdentity(value.content);
    if (identity == null) {
      return { ok: false, result: block('malformed', hitOffset(hits, 'content', 'action')) };
    }
    content = identity;
  }
  let target: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'target')) {
    const identity = canonicalIdentity(value.target);
    if (identity == null) {
      return { ok: false, result: block('malformed', hitOffset(hits, 'target', 'action')) };
    }
    target = identity;
  }
  let revision: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'revision')) {
    const identity = canonicalIdentity(value.revision);
    if (identity == null) {
      return { ok: false, result: block('malformed', hitOffset(hits, 'revision', 'action')) };
    }
    revision = identity;
  }
  let allowance: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'allowance')) {
    const parsedAllowance = canonicalAllowance(value.allowance);
    if (parsedAllowance == null) {
      return { ok: false, result: block('malformed', hitOffset(hits, 'allowance', 'action')) };
    }
    allowance = parsedAllowance;
  }

  const missing =
    (kind === 'value_transfer' &&
      (amount.value === undefined || asset === undefined || recipient === undefined)) ||
    (kind === 'permission' &&
      (allowance === undefined || asset === undefined || recipient === undefined)) ||
    (kind === 'informational' && (content === undefined || recipient === undefined)) ||
    (kind === 'deploy_ship' && (target === undefined || revision === undefined));
  if (missing) {
    return { ok: false, result: block('action_not_concrete', hitOffset(hits, 'action', null)) };
  }

  const action: NormalizedAction = { kind };
  if (amount.value !== undefined) action.amount = amount.value;
  if (asset !== undefined) action.asset = asset;
  if (recipient !== undefined) action.recipient = recipient;
  if (allowance !== undefined) action.allowance = allowance;
  if (content !== undefined) action.content = content;
  if (target !== undefined) action.target = target;
  if (revision !== undefined) action.revision = revision;
  return { ok: true, action };
}

function finish(
  mandate: NormalizedMandate,
  hits: KeyHit[] | null,
): MandateNormalizeResult {
  const canonicalJson = jcs(mandate);
  if (canonicalJson == null) return block('malformed');
  const canonicalBytes = utf8Bytes(canonicalJson);
  if (canonicalBytes > MANDATE_MAX_UTF8_BYTES) return block('too_large');
  const spans = actionSpan(hits);
  if (spans) {
    return { ok: true, mandate, canonicalJson, canonicalBytes, spans };
  }
  return { ok: true, mandate, canonicalJson, canonicalBytes };
}

function normalizeObject(value: unknown, hits: KeyHit[] | null, fromText: boolean): MandateNormalizeResult {
  const at = (offset: number | undefined): number | undefined => (fromText ? offset ?? 0 : undefined);
  if (hits) {
    for (const hit of hits) {
      if (PROTOTYPE_KEYS.has(hit.key)) return block('prototype_key', hit.offset);
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return block('not_object', at(0));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return block('prototype_key', at(0));
  }
  if (!isPlainObject(value)) return block('not_object', at(0));

  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    if (PROTOTYPE_KEYS.has(name)) return block('prototype_key', hitOffset(hits, name, null) ?? at(0));
  }
  if (names.length > MANDATE_MAX_KEYS) {
    const extra = names[MANDATE_MAX_KEYS] ?? names[0] ?? '';
    return block('too_large', hitOffset(hits, extra, null) ?? at(0));
  }
  if (names.length === 0) return block('empty', at(0));

  for (const name of names) {
    const bad = rejectBadKey(name, TOP_KEYS, hits, null);
    if (bad) return bad;
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'action')) {
    return block('action_missing', at(0));
  }

  const action = parseAction(value.action, hits);
  if (!action.ok) return action.result;

  let mandateKind: ConcreteActionKind | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'kind')) {
    if (!isConcreteKind(value.kind)) {
      return block('malformed', hitOffset(hits, 'kind', null) ?? at(0));
    }
    mandateKind = value.kind;
  }

  let granted: NormalizedGranted | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'granted')) {
    const parsed = parseGranted(value.granted, hits);
    if (!parsed.ok) return parsed.result;
    granted = parsed.granted;
  }

  const mandate: NormalizedMandate = { action: action.action };
  if (mandateKind !== undefined) mandate.kind = mandateKind;
  if (granted) mandate.granted = granted;
  return finish(mandate, hits);
}

function normalizeMandateInner(input: unknown): MandateNormalizeResult {
  if (typeof input === 'string') {
    if (utf8Bytes(input) > MANDATE_MAX_UTF8_BYTES) return block('too_large', 0);
    const scanned = scanMandateText(input);
    if (!scanned.ok) return block('malformed', scanned.offset);
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return block('malformed', 0);
    }
    return normalizeObject(parsed, scanned.hits, true);
  }
  return normalizeObject(input, null, false);
}

/**
 * Validate and normalize one mandate. Does not throw. Does not return ALLOW.
 * String input is original JSON text: size, offsets, and the parse all use
 * that text.
 */
export function normalizeMandate(input: unknown): MandateNormalizeResult {
  try {
    return normalizeMandateInner(input);
  } catch {
    return block('malformed');
  }
}

/**
 * A failed normalization is known-invalid: BLOCK, including when the gate
 * verdict is ALLOW or UNCERTAIN and including when the signature verified.
 * `signatureVerified` is not read. An existing BLOCK stays BLOCK.
 * When normalization succeeds, ALLOW stays ALLOW and UNCERTAIN stays
 * UNCERTAIN. The signature does not make either change.
 */
export function verdictWithMandateNormalization(
  gateVerdict: MandateGateVerdict,
  normalization: MandateNormalizeResult,
  signatureVerified: boolean,
): MandateGateVerdict {
  void signatureVerified;
  if (gateVerdict === 'BLOCK') return 'BLOCK';
  if (!normalization.ok) return 'BLOCK';
  return gateVerdict;
}
