/**
 * ADR-0023 stage 2: one atomic nonce consume on the shared Redis store.
 * Not called from the verify handler. Not a verdict input.
 * There is no in-memory fallback. A store miss or error is HTTP 503,
 * never ALLOW.
 *
 * Expiry uses Redis TIME inside the script. Callers cannot supply a clock.
 * The pure window helper is not consulted and does not consume a nonce.
 * The replay client is separate from the rate-limit client and does not
 * retry a lost transport response.
 */

import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { resolveUpstashConfig } from './upstash-env.js';

/** Same product decision as the proof window. Not a tunable default. */
export const MANDATE_REPLAY_SKEW_SECONDS = 30;

const KEY_PREFIX = 'sentinel:mandate-replay:v1:';

/**
 * EVAL runs the check and SET NX together. Retention is EX until
 * exp + skew + 1 so the key is still present at exp + skew.
 * A caller cannot widen the skew: it is fixed in this script.
 */
export const MANDATE_REPLAY_CONSUME_SCRIPT = `
local skew = ${MANDATE_REPLAY_SKEW_SECONDS}
local function intstr(s)
  if type(s) ~= 'string' or string.match(s, '^-?%d+$') == nil then
    return nil
  end
  return tonumber(s)
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
if exp <= now - skew then
  return 'block:expired'
end
local ttl = (exp + skew + 1) - now
if ttl < 1 then
  return 'block:expired'
end
local set = redis.call('SET', KEYS[1], '1', 'EX', ttl, 'NX')
if set then
  return 'consumed:' .. tostring(exp + skew + 1)
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

export type MandateReplayConsumeResult =
  | { ok: true; consumed: true; retainUntil: number }
  | { ok: false; verdict: 'BLOCK'; reason: 'non_positive_window' | 'expired' | 'replay' }
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
    if (reason === 'non_positive_window' || reason === 'expired' || reason === 'replay') {
      return { ok: false, verdict: 'BLOCK', reason };
    }
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
 * There is no memory store and no caller clock.
 */
export async function consumeMandateNonce(
  input: MandateReplayConsumeInput,
  command?: MandateReplayCommand | null,
): Promise<MandateReplayConsumeResult> {
  if (!input.accountId || !input.nonce) {
    return unavailable('ACCOUNT_UNAVAILABLE');
  }

  let redis: MandateReplayCommand | null;
  try {
    redis = command === undefined ? commandFromDedicatedClient() : command;
  } catch {
    return unavailable('REPLAY_STORE_UNAVAILABLE');
  }
  if (!redis) return unavailable('REPLAY_STORE_UNAVAILABLE');

  try {
    const raw = await redis.eval(MANDATE_REPLAY_CONSUME_SCRIPT, [mandateReplayKey(input.accountId, input.nonce)], [
      String(input.iat),
      String(input.exp),
    ]);
    if (typeof raw !== 'string') return unavailable('REPLAY_STORE_UNAVAILABLE');
    return parseReply(raw, input.exp);
  } catch {
    return unavailable('REPLAY_STORE_UNAVAILABLE');
  }
}
