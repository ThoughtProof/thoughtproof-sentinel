/**
 * Productive manifest and account policy. Offline doubles only.
 * No network and no provider keys.
 */
import { describe, expect, it } from 'vitest';
import { defaultMandateRequestDeps } from './mandate-request-path.js';
import {
  ACCOUNT_POLICY_CAS_SCRIPT,
  ACCOUNT_POLICY_LOAD_SCRIPT,
  MIGRATION_ACCOUNT_POLICIES,
  PRINCIPAL_MANIFEST_CAS_SCRIPT,
  PRINCIPAL_MANIFEST_LOAD_SCRIPT,
  PRINCIPAL_STORE_DEADLINE_MS,
  createProductiveManifestStore,
  persistMigrationAccountPolicy,
  readProductiveAccountPolicy,
  type PrincipalRedisCommand,
} from './principal-manifest-store.js';

const ACCOUNT = 'acct_v3api';
const OTHER = 'acct-not-migrated';

function memoryRedis(): PrincipalRedisCommand & { keys: string[] } {
  const hashes = new Map<string, Map<string, string>>();
  const seen: string[] = [];
  return {
    keys: seen,
    async eval(script: string, keys: string[], args: string[]) {
      const redisKey = keys[0] ?? '';
      seen.push(redisKey);
      const hash = hashes.get(redisKey) ?? new Map<string, string>();
      if (script === PRINCIPAL_MANIFEST_LOAD_SCRIPT || script === ACCOUNT_POLICY_LOAD_SCRIPT) {
        const version = hash.get('version');
        const field = script === PRINCIPAL_MANIFEST_LOAD_SCRIPT ? 'manifest' : 'status';
        const body = hash.get(field);
        if (!version && !body) return script === PRINCIPAL_MANIFEST_LOAD_SCRIPT ? 'empty' : 'missing';
        if (!version || body === undefined) return 'bad';
        return `doc\n${version}\n${body}`;
      }
      const expected = args[0] ?? '';
      const document = args[1] ?? '';
      if (!/^\d+$/.test(expected) || document.length === 0) return 'bad';
      if (script === ACCOUNT_POLICY_CAS_SCRIPT && document !== 'legacy' && document !== 'protected') {
        return 'bad';
      }
      if (script !== PRINCIPAL_MANIFEST_CAS_SCRIPT && script !== ACCOUNT_POLICY_CAS_SCRIPT) return 'bad';
      const version = hash.get('version') ?? '0';
      if (version !== expected) return 'mismatch';
      const next = String(Number(version) + 1);
      hash.set('version', next);
      hash.set(script === PRINCIPAL_MANIFEST_CAS_SCRIPT ? 'manifest' : 'status', document);
      hashes.set(redisKey, hash);
      return `ok:${next}`;
    },
  };
}

describe('productive principal manifest store', () => {
  it('replaces the null default and fails closed without Redis', async () => {
    expect(PRINCIPAL_STORE_DEADLINE_MS).toBe(2_000);
    const deps = defaultMandateRequestDeps({});
    expect(deps.manifestStore).not.toBeNull();
    const loaded = await deps.manifestStore?.load(ACCOUNT);
    expect(loaded).toEqual({ answered: false });
    expect(await deps.readPolicy(ACCOUNT)).toBe('unreadable');
    expect(await deps.readPolicy(OTHER)).toBe('unreadable');

    const invalid = createProductiveManifestStore({
      environment: 'production',
      env: { UPSTASH_REDIS_REST_URL: 'https://example.upstash.io' },
    });
    expect(await invalid.load(ACCOUNT)).toEqual({ answered: false });
    expect(await readProductiveAccountPolicy(ACCOUNT, {
      environment: 'production',
      env: { UPSTASH_REDIS_REST_URL: 'not a url', UPSTASH_REDIS_REST_TOKEN: 'tok' },
    })).toBe('unreadable');
  });

  it('answers an empty manifest and compare-and-sets without putting the account id in the key', async () => {
    const command = memoryRedis();
    const store = createProductiveManifestStore({ environment: 'production', command, env: {} });
    const first = await store.load(ACCOUNT);
    expect(first).toEqual({ answered: true, version: '0', manifest: null });
    const manifest = {
      accountId: ACCOUNT,
      keys: [] as [],
    };
    const wrote = await store.compareAndSet(ACCOUNT, '0', manifest);
    expect(wrote).toEqual({ ok: true, version: '1' });
    const again = await store.load(ACCOUNT);
    expect(again).toEqual({ answered: true, version: '1', manifest });
    expect(command.keys.every((key) => !key.includes(ACCOUNT))).toBe(true);
    expect(command.keys.every((key) => key.startsWith('sentinel:principal-manifest:v1:'))).toBe(true);

    const raced = await store.compareAndSet(ACCOUNT, '0', manifest);
    expect(raced).toEqual({ ok: false });
  });

  it('fails closed on a bad reply, a throw, or a silent command', async () => {
    const bad = createProductiveManifestStore({
      environment: 'production',
      env: {},
      command: { async eval() { return 'token-leaked-reply'; } },
    });
    expect(await bad.load(ACCOUNT)).toEqual({ answered: false });
    await expect(bad.compareAndSet(ACCOUNT, '0', { accountId: ACCOUNT, keys: [] })).rejects.toThrow(
      'principal_store_unavailable',
    );

    const thrown = createProductiveManifestStore({
      environment: 'production',
      env: {},
      command: {
        async eval() {
          throw new Error('redis token leaked-manifest');
        },
      },
    });
    const failed = await thrown.load(ACCOUNT);
    expect(failed).toEqual({ answered: false });
    expect(JSON.stringify(failed)).not.toContain('leaked-manifest');

    const silent = createProductiveManifestStore({
      environment: 'production',
      env: {},
      command: { eval: () => new Promise(() => undefined) },
    });
    const started = Date.now();
    expect(await silent.load(ACCOUNT)).toEqual({ answered: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(PRINCIPAL_STORE_DEADLINE_MS);
    expect(Date.now() - started).toBeLessThan(PRINCIPAL_STORE_DEADLINE_MS + 2_000);
  }, 8_000);

  it('reads legacy for the three accounts only when Redis answers, and fails closed on error', async () => {
    const command = memoryRedis();
    const input = { environment: 'production' as const, command, env: {} };
    expect(MIGRATION_ACCOUNT_POLICIES).toEqual({
      acct_v3api: 'legacy',
      acct_grokbot: 'legacy',
      acct_nightly: 'legacy',
    });
    for (const accountId of Object.keys(MIGRATION_ACCOUNT_POLICIES)) {
      expect(await readProductiveAccountPolicy(accountId, input)).toBe('legacy');
    }
    expect(await readProductiveAccountPolicy(OTHER, input)).toBe('unreadable');
    expect(await persistMigrationAccountPolicy(ACCOUNT, input)).toBe(true);
    expect(await readProductiveAccountPolicy(ACCOUNT, input)).toBe('legacy');
    expect(command.keys.every((key) => !key.includes(ACCOUNT) && !key.includes('v3api'))).toBe(true);

    const down = {
      environment: 'production' as const,
      env: {},
      command: {
        async eval() {
          throw new Error('redis token leaked-policy');
        },
      },
    };
    expect(await readProductiveAccountPolicy(ACCOUNT, down)).toBe('unreadable');
    expect(await persistMigrationAccountPolicy(ACCOUNT, down)).toBe(false);
    expect(await readProductiveAccountPolicy(ACCOUNT, { environment: undefined, command, env: {} })).toBe(
      'unreadable',
    );

    const garbage = {
      environment: 'production' as const,
      env: {},
      command: { async eval() { return 'doc\n1\ncaller_declared'; } },
    };
    expect(await readProductiveAccountPolicy(ACCOUNT, garbage)).toBe('unreadable');

    const protectedRow = {
      environment: 'production' as const,
      env: {},
      command: { async eval() { return 'doc\n4\nprotected'; } },
    };
    expect(await readProductiveAccountPolicy(ACCOUNT, protectedRow)).toBe('protected');
  });
});
