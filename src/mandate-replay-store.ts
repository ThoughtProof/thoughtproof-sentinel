/**
 * ADR-0023 stage 2: one atomic nonce consume on the shared Redis store.
 * Not a verdict input. Not wired here. The request-path module is a
 * separate stage and is the only caller, and only when enforcement is on.
 * There is no in-memory fallback. A store miss, a timeout, or an error
 * is HTTP 503, never ALLOW.
 *
 * Expiry and not-before use Redis TIME inside the script. Callers cannot
 * supply a clock. The pure window helper is not consulted and does not
 * consume a nonce. The replay client is separate from the rate-limit
 * client and does not retry a lost transport response.
 */

import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { resolveUpstashConfig } from './upstash-env.js';

/** Same product decision as the proof window. Not a tunable default. */
export const MANDATE_REPLAY_SKEW_SECONDS = 30;

/** Same product decision as the proof window. Not a tunable default. */
export const MANDATE_REPLAY_MAX_WINDOW_SECONDS = 300;

/**
 * A silent store past this deadline is the same as no answer.
 * Matches the principal-manifest load deadline. Not a clock for expiry.
 */
export const MANDATE_REPLAY_DEADLINE_MS = 2_000;

const KEY_PREFIX = 'sentinel:mandate-replay:v1:';

/**
 * EVAL runs the time check and SET NX PXAT together. The clock is Redis
 * TIME. A caller cannot pass a third argument to widen the skew or the
 * window. Retention is an absolute PXAT at exp + skew + 1 so the key is
 * still present throughout the second exp + skew.
 */
export const MANDATE_REPLAY_CONSUME_SCRIPT = `
local skew = ${MANDATE_REPLAY_SKEW_SECONDS}
local maxWindow = ${MANDATE_REPLAY_MAX_WINDOW_SECONDS}
local function intstr(s)
  if type(s) ~= 'string' or string.match(s, '^%d+$') == nil or #s > 15 then
    return nil
  end
  local n = tonumber(s)
  if n == nil or n ~= math.floor(n) or n < 0 then
    return nil
  end
  return n
end
local iat = intstr(ARGV[1])
local exp = intstr(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1])
if iat == nil or exp == nil or now == nil then
  return 'block:non_positive_window'
end
if exp <= iat then
  return 'block:non_positive_window'
end
if exp - iat > maxWindow then
  return 'block:window_too_long'
end
if iat > now + skew then
  return 'block:not_yet_valid'
end
if exp <= now - skew then
  return 'block:expired'
end
local expireAt = exp + skew + 1
if expireAt <= now then
  return 'block:expired'
end
local set = redis.call('SET', KEYS[1], '1', 'PXAT', string.format('%.0f', expireAt * 1000), 'NX')
if set then
  return 'consumed:' .. string.format('%.0f', expireAt)
end
return 'block:replay'
`.trim();

export interface MandateReplayCommand {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  pttl(key: string): Promise<number>;
}

export interface MandateReplayConsumeInput {
  /** Stage-1 server account id. Request fields are not read here. */
  accountId: string;
  nonce: string;
  iat: number;
  exp: number;
}

export const MANDATE_REPLAY_BLOCK_REASONS = [
  'non_positive_window',
  'window_too_long',
  'not_yet_valid',
  'expired',
  'replay',
] as const;

export type MandateReplayBlockReason = (typeof MANDATE_REPLAY_BLOCK_REASONS)[number];

export type MandateReplayConsumeResult =
  | { ok: true; consumed: true; retainUntil: number }
  | { ok: false; verdict: 'BLOCK'; reason: MandateReplayBlockReason }
  | { ok: false; httpStatus: 503; code: 'ACCOUNT_UNAVAILABLE' | 'REPLAY_STORE_UNAVAILABLE' };

/** Redis key for one account's nonce. The raw nonce is not the key. */
export function mandateReplayKey(accountId: string, nonce: string): string {
  const digest = createHash('sha256')
    .update(accountId, 'utf8')
    .update('\0', 'utf8')
    .update(nonce, 'utf8')
    .digest('hex');
  return KEY_PREFIX + digest;
}

function unavailable(code: 'ACCOUNT_UNAVAILABLE' | 'REPLAY_STORE_UNAVAILABLE'): MandateReplayConsumeResult {
  return { ok: false, httpStatus: 503, code };
}

function block(reason: MandateReplayBlockReason): MandateReplayConsumeResult {
  return { ok: false, verdict: 'BLOCK', reason };
}

function isBlockReason(value: string): value is MandateReplayBlockReason {
  return (MANDATE_REPLAY_BLOCK_REASONS as readonly string[]).includes(value);
}

/**
 * Decimal seconds the script can compare exactly. Not a clock check.
 * A negative, fractional, or oversized value is known-invalid.
 */
function canonicalSeconds(value: number): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  const text = String(value);
  if (!/^\d{1,15}$/.test(text)) return null;
  return text;
}

function withDeadline<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  return new Promise<T>((resolve, reject) => {
    const clear = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clear();
      settle();
    };
    timer = setTimeout(() => {
      timer = undefined;
      finish(() => reject(new Error('mandate_replay_deadline')));
    }, ms);
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/**
 * Dedicated Upstash client for nonce consumption.
 * `retry: false` still performs two attempts in @upstash/redis 1.38
 * (`attempts: 1` and a loop of `i <= attempts`). `retries: 0` is one attempt.
 * The shared rate-limit client is not modified.
 */
export function createMandateReplayClient(url: string, token: string): Redis {
  return new Redis({
    url,
    token,
    retry: { retries: 0 },
  });
}

export function mandateReplayCommand(redis: Redis): MandateReplayCommand {
  return {
    eval(script, keys, args) {
      return redis.createScript<string>(script).eval(keys, args);
    },
    pttl(key) {
      return redis.pttl(key);
    },
  };
}

let replayClient: Redis | null = null;
let replayClientKey: string | null = null;

function commandFromDedicatedClient(): MandateReplayCommand | null {
  const cfg = resolveUpstashConfig();
  if (cfg.status !== 'configured') return null;
  const key = `${cfg.url}\0${cfg.token.length}`;
  if (!replayClient || replayClientKey !== key) {
    replayClient = createMandateReplayClient(cfg.url, cfg.token);
    replayClientKey = key;
  }
  return mandateReplayCommand(replayClient);
}

function parseReply(raw: string, exp: number): MandateReplayConsumeResult {
  if (raw.startsWith('block:')) {
    const reason = raw.slice('block:'.length);
    if (isBlockReason(reason)) return block(reason);
  }
  const marker = 'consumed:';
  if (raw.startsWith(marker)) {
    const expireAt = Number(raw.slice(marker.length));
    const retainUntil = exp + MANDATE_REPLAY_SKEW_SECONDS;
    if (expireAt === retainUntil + 1) {
      return { ok: true, consumed: true, retainUntil };
    }
  }
  return unavailable('REPLAY_STORE_UNAVAILABLE');
}

/**
 * Consume a nonce once, or reject it. Pass `command` in tests.
 * Omit `command` to use the dedicated no-retry Upstash client.
 * There is no memory store and no caller clock. The script's Redis TIME
 * is the authoritative expiry and not-before check. A deadline, a thrown
 * client, or a missing client is HTTP 503 and is not ALLOW.
 */
export async function consumeMandateNonce(
  input: MandateReplayConsumeInput,
  command?: MandateReplayCommand | null,
): Promise<MandateReplayConsumeResult> {
  if (typeof input.accountId !== 'string' || input.accountId.trim() === '') {
    return unavailable('ACCOUNT_UNAVAILABLE');
  }
  if (typeof input.nonce !== 'string' || input.nonce.trim() === '') {
    return unavailable('ACCOUNT_UNAVAILABLE');
  }
  const iat = canonicalSeconds(input.iat);
  const exp = canonicalSeconds(input.exp);
  if (iat === null || exp === null) {
    return block('non_positive_window');
  }

  let redis: MandateReplayCommand | null;
  try {
    redis = command === undefined ? commandFromDedicatedClient() : command;
  } catch {
    return unavailable('REPLAY_STORE_UNAVAILABLE');
  }
  if (!redis) return unavailable('REPLAY_STORE_UNAVAILABLE');

  try {
    const raw = await withDeadline(
      redis.eval(MANDATE_REPLAY_CONSUME_SCRIPT, [mandateReplayKey(input.accountId, input.nonce)], [iat, exp]),
      MANDATE_REPLAY_DEADLINE_MS,
    );
    if (typeof raw !== 'string') return unavailable('REPLAY_STORE_UNAVAILABLE');
    return parseReply(raw, input.exp);
  } catch {
    return unavailable('REPLAY_STORE_UNAVAILABLE');
  }
}
