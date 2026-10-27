/**
 * Offline account binding. Env fixtures only. No network and no provider keys.
 * Key material stays in local variables and is not logged.
 */
import { describe, expect, it } from 'vitest';
import { resolveServerAccountId } from './server-account.js';

const KEY_ONE = 'sk_key_one';
const KEY_TWO = 'sk_key_two';

function keysEnv(raw: unknown): Record<string, unknown> {
  return { SENTINEL_API_KEYS: raw };
}

describe('resolveServerAccountId', () => {
  it('returns a stable account id for the same key', () => {
    const env = keysEnv(`${KEY_ONE}:openserv:agent42:acct-one`);
    const first = resolveServerAccountId({ apiKey: KEY_ONE, env });
    const second = resolveServerAccountId({ apiKey: KEY_ONE, env });
    expect(first).toEqual({ ok: true, accountId: 'acct-one' });
    expect(second).toEqual(first);
  });

  it('returns different account ids for different keys', () => {
    const env = keysEnv(
      `${KEY_ONE}:openserv:agent42:acct-one,${KEY_TWO}:acp:0xABC:acct-two`,
    );
    const one = resolveServerAccountId({ apiKey: KEY_ONE, env });
    const two = resolveServerAccountId({ apiKey: KEY_TWO, env });
    expect(one).toEqual({ ok: true, accountId: 'acct-one' });
    expect(two).toEqual({ ok: true, accountId: 'acct-two' });
    if (one.ok && two.ok) expect(one.accountId).not.toBe(two.accountId);
  });

  it('ignores a spoofed request account field and X-Sentinel-Agent-Id', () => {
    const env = keysEnv(`${KEY_ONE}:openserv:agent42:acct-from-record`);
    const result = resolveServerAccountId({
      apiKey: KEY_ONE,
      requestAccountId: 'spoofed-account',
      agentIdHeader: 'spoofed-agent',
      env,
    });
    expect(result).toEqual({ ok: true, accountId: 'acct-from-record' });
    if (result.ok) {
      expect(result.accountId).not.toBe('spoofed-account');
      expect(result.accountId).not.toBe('spoofed-agent');
      expect(result.accountId).not.toBe('agent42');
    }
  });

  it('fails closed when the matched record has no account id', () => {
    const env = keysEnv(`${KEY_ONE}:openserv:agent42`);
    const result = resolveServerAccountId({
      apiKey: KEY_ONE,
      requestAccountId: 'spoofed-account',
      agentIdHeader: 'agent42',
      env,
    });
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });
    expect(result).not.toHaveProperty('accountId');
    expect(result).not.toHaveProperty('verdict');
  });

  it('fails closed when the key record is missing', () => {
    const env = keysEnv(`${KEY_ONE}:openserv:agent42:acct-one`);
    const result = resolveServerAccountId({ apiKey: 'sk_wrong_key', env });
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });
  });

  it('fails closed when the account record is unreadable', () => {
    const env = {};
    Object.defineProperty(env, 'SENTINEL_API_KEYS', {
      get() {
        throw new Error('unreadable');
      },
    });
    const thrown = resolveServerAccountId({ apiKey: KEY_ONE, env });
    expect(thrown).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });

    const notAString = resolveServerAccountId({
      apiKey: KEY_ONE,
      env: keysEnv({ not: 'a string' }),
    });
    expect(notAString).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });

    const missing = resolveServerAccountId({ apiKey: KEY_ONE, env: {} });
    expect(missing).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });
  });

  it('fails closed on a blank account field instead of using the agent id', () => {
    const env = keysEnv(`${KEY_ONE}:openserv:agent42:`);
    const result = resolveServerAccountId({ apiKey: KEY_ONE, env });
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });
  });
});
