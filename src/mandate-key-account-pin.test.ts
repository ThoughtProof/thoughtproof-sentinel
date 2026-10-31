/**
 * Operator pin selection. Offline. Fixture keys are not production keys.
 * Output assertions reject key material.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { key_fp } from './mandate-key-account-census.js';
import {
  APPROVED_KEY_ACCOUNTS,
  CENSUS_PROVES,
  applyApprovedKeyPin,
  inspectSigningKey,
  publicPinRow,
  selectKeyAccounts,
} from './mandate-key-account-pin.js';
import {
  ACCOUNT_POLICY_LOAD_SCRIPT,
  PRINCIPAL_MANIFEST_CAS_SCRIPT,
  PRINCIPAL_MANIFEST_LOAD_SCRIPT,
  createProductiveManifestStore,
  type PrincipalRedisCommand,
} from './principal-manifest-store.js';
import type { PrincipalAdminPinStore } from './principal-key-admin.js';

const SCRIPT = fileURLToPath(new URL('../scripts/pin-key-account.ts', import.meta.url));
const REGISTER = fileURLToPath(new URL('../scripts/register-ts-extension.mjs', import.meta.url));
const NOW = 1_800_000_000;
const FIXTURE_KEY = 'sk_pin_script_fixture_do_not_print';
const CANARY = 'public-key-canary-do-not-print';

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function okpX(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

function publicKey(x: string, kid: string): Record<string, unknown> {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    x,
    kid,
    status: 'active',
    notBefore: iso(NOW - 1000),
    notAfter: iso(NOW + 1000),
  };
}

function memoryRedis(): PrincipalRedisCommand {
  const hashes = new Map<string, Map<string, string>>();
  return {
    async eval(script: string, keys: string[], args: string[]) {
      const redisKey = keys[0] ?? '';
      const hash = hashes.get(redisKey) ?? new Map<string, string>();
      if (script === PRINCIPAL_MANIFEST_LOAD_SCRIPT || script === ACCOUNT_POLICY_LOAD_SCRIPT) {
        const version = hash.get('version');
        const field = script === PRINCIPAL_MANIFEST_LOAD_SCRIPT ? 'manifest' : 'status';
        const body = hash.get(field);
        if (!version && body === undefined) {
          return script === PRINCIPAL_MANIFEST_LOAD_SCRIPT ? 'empty' : 'missing';
        }
        if (!version || body === undefined) return 'bad';
        return `doc\n${version}\n${body}`;
      }
      const expected = args[0] ?? '';
      const document = args[1] ?? '';
      if (!/^\d+$/.test(expected)) return 'bad';
      const version = hash.get('version') ?? '0';
      if (version !== expected) return 'mismatch';
      const next = String(Number(version) + 1);
      const field = script === PRINCIPAL_MANIFEST_CAS_SCRIPT ? 'manifest' : 'status';
      if (script !== PRINCIPAL_MANIFEST_CAS_SCRIPT) return 'bad';
      hash.set('version', next);
      hash.set(field, document);
      hashes.set(redisKey, hash);
      return `ok:${next}`;
    },
  };
}

function runScript(args: string[], env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--import',
      REGISTER,
      SCRIPT,
      ...args,
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } },
  );
}

describe('approved key fingerprints', () => {
  it('keeps Raul\'s three accounts and does not copy the agent id', () => {
    expect(APPROVED_KEY_ACCOUNTS.map((row) => row.key_fp)).toEqual([
      '104867493888',
      '00f666d19701',
      '74541b14c65c',
    ]);
    expect(APPROVED_KEY_ACCOUNTS.map((row) => row.accountId)).toEqual([
      'acct_v3api',
      'acct_grokbot',
      'acct_nightly',
    ]);
    expect(APPROVED_KEY_ACCOUNTS.map((row) => row.agent_id)).toEqual([
      'v3api',
      'grokbot',
      'nightly-suite',
    ]);
    for (const row of APPROVED_KEY_ACCOUNTS) {
      expect(row.accountId).not.toBe(row.agent_id);
    }
  });

  it('selects by key_fp and the public row omits the key and the account', () => {
    const table = [{ key_fp: key_fp(FIXTURE_KEY), accountId: 'acct_fixture_pin', agent_id: 'v3api' }];
    const raw = `${FIXTURE_KEY}:direct:v3api,sk_pin_other_fixture:direct:grokbot`;
    const selections = selectKeyAccounts(raw, table);
    expect(selections).not.toBeNull();
    const approved = selections?.find((row) => row.status === 'approved');
    expect(approved?.accountId).toBe('acct_fixture_pin');
    const printed = selections?.map((row) => publicPinRow(row));
    const json = JSON.stringify(printed);
    expect(json).toContain(key_fp(FIXTURE_KEY));
    expect(json).not.toContain(FIXTURE_KEY);
    expect(json).not.toContain('acct_fixture_pin');
    expect(json).not.toContain('sk_pin_other_fixture');
    expect(json).toContain('unapproved');
    expect(selectKeyAccounts(1)).toBeNull();
  });
});

describe('applyApprovedKeyPin', () => {
  it('pins through pinPrincipalKeyAsAdmin and does not return key material', async () => {
    const pair = generateKeyPairSync('ed25519');
    const x = okpX(pair.publicKey);
    const kid = 'kid-pin-fixture';
    const key = publicKey(x, kid);
    const apiKey = 'sk_apply_pin_fixture';
    const accountId = 'acct_v3api';
    const table = [{ key_fp: key_fp(apiKey), accountId, agent_id: 'v3api' }];
    const command = memoryRedis();
    const order: string[] = [];
    const wrapped: PrincipalRedisCommand = {
      async eval(script, keys, args) {
        order.push(script === ACCOUNT_POLICY_LOAD_SCRIPT ? 'policy' : 'manifest');
        return command.eval(script, keys, args);
      },
    };
    const store = createProductiveManifestStore({
      environment: 'production',
      command: wrapped,
      env: {},
    });
    const result = await applyApprovedKeyPin({
      raw: `${apiKey}:direct:v3api`,
      keyFp: key_fp(apiKey),
      environment: 'production',
      nowSeconds: NOW,
      publicKey: key,
      store,
      table,
    });
    expect(result).toEqual({
      mode: 'apply',
      key_fp: key_fp(apiKey),
      status: 'ACCEPTED',
      authorizes_execution: false,
    });
    expect(order.length).toBeGreaterThan(0);
    expect(order.every((step) => step === 'manifest')).toBe(true);
    const json = JSON.stringify(result);
    expect(json).not.toContain(apiKey);
    expect(json).not.toContain(x);
    expect(json).not.toContain(kid);
    expect(json).not.toContain(accountId);
    expect(json).not.toContain('ALLOW');

    const again = await applyApprovedKeyPin({
      raw: `${apiKey}:direct:v3api`,
      keyFp: key_fp(apiKey),
      environment: 'production',
      nowSeconds: NOW,
      publicKey: key,
      store,
      table,
    });
    expect(again.status).toBe('DUPLICATE_KEY');
    expect(JSON.stringify(again)).not.toContain(x);
  });

  it('does not write when the fingerprint is not approved or the key carries a private field', async () => {
    let loads = 0;
    const store: PrincipalAdminPinStore = {
      async load() {
        loads += 1;
        return { answered: true, version: '0', manifest: null };
      },
      async compareAndSet(): Promise<{ ok: true; version: string }> {
        throw new Error('compare should not run');
      },
    };
    const missing = await applyApprovedKeyPin({
      raw: `${FIXTURE_KEY}:direct:v3api`,
      keyFp: '104867493888',
      environment: 'production',
      nowSeconds: NOW,
      publicKey: { kty: 'OKP' },
      store,
    });
    expect(missing.status).toBe('absent');
    expect(loads).toBe(0);

    const table = [{ key_fp: key_fp(FIXTURE_KEY), accountId: 'acct_fixture_pin' }];
    const leaked = await applyApprovedKeyPin({
      raw: `${FIXTURE_KEY}:direct:v3api`,
      keyFp: key_fp(FIXTURE_KEY),
      environment: 'production',
      nowSeconds: NOW,
      publicKey: { kty: 'OKP', seed: 'not-a-real-seed-value' },
      store,
      table,
    });
    expect(leaked.status).toBe('PRIVATE_KEY_PRESENT');
    expect(loads).toBe(0);
    expect(JSON.stringify(leaked)).not.toContain('not-a-real-seed-value');
    expect(JSON.stringify(leaked)).not.toContain(FIXTURE_KEY);
  });
});

function livePublicKey(over: Record<string, unknown> = {}): { json: string; x: string; kid: string } {
  const pair = generateKeyPairSync('ed25519');
  const x = okpX(pair.publicKey);
  const kid = 'kid-dry-run-fixture';
  const now = Math.floor(Date.now() / 1000);
  return {
    x,
    kid,
    json: JSON.stringify({
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      x,
      kid,
      status: 'active',
      notBefore: iso(now - 60),
      notAfter: iso(now + 3600),
      ...over,
    }),
  };
}

describe('signing key inspection', () => {
  it('accepts an active Ed25519 key inside its window and prints only the fingerprint', () => {
    const pair = generateKeyPairSync('ed25519');
    const x = okpX(pair.publicKey);
    const inspected = inspectSigningKey(publicKey(x, 'kid-inspect'), NOW);
    expect(inspected).toEqual({
      ok: true,
      signer_fp: key_fp(x),
      authorizesExecution: false,
    });
    expect(JSON.stringify(inspected)).not.toContain(x);
    expect(JSON.stringify(inspected)).not.toContain('kid-inspect');

    const expired = inspectSigningKey(
      publicKey(x, 'kid-inspect', ),
      NOW + 10_000,
    );
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.status).toBe('WINDOW_INVALID');

    const inactive = inspectSigningKey({ ...publicKey(x, 'kid-inspect'), status: 'retired' }, NOW);
    expect(inactive.ok).toBe(false);
    if (!inactive.ok) expect(inactive.status).toBe('ROTATED_KEY');

    const wrongType = inspectSigningKey({ ...publicKey(x, 'kid-inspect'), kty: 'EC' }, NOW);
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.status).toBe('MALFORMED_REQUEST');
  });
});

describe('pin-key-account script', () => {
  it('dry-run requires a valid signing key and reports that census is not signer binding', () => {
    const signer = livePublicKey();
    const ran = runScript(['--environment', 'production'], {
      SENTINEL_API_KEYS: `${FIXTURE_KEY}:direct:v3api`,
      SENTINEL_PRINCIPAL_PUBLIC_KEY: signer.json,
    });
    expect(ran.status).toBe(0);
    const report = JSON.parse(ran.stdout) as {
      mode: string;
      signer_fp: string;
      signer_status: string;
      census_proves: string;
      signer_binding_proven: boolean;
      keys: Array<{ key_fp: string; status: string }>;
    };
    expect(report.mode).toBe('dry_run');
    expect(report.signer_status).toBe('valid');
    expect(report.signer_fp).toBe(key_fp(signer.x));
    expect(report.census_proves).toBe(CENSUS_PROVES);
    expect(report.signer_binding_proven).toBe(false);
    expect(report.keys).toEqual([
      { key_fp: key_fp(FIXTURE_KEY), status: 'unapproved', authorizes_execution: false },
    ]);
    expect(ran.stdout).not.toContain(FIXTURE_KEY);
    expect(ran.stdout).not.toContain(signer.x);
    expect(ran.stdout).not.toContain(signer.kid);
    expect(ran.stdout).not.toContain('ALLOW');
    expect(ran.stderr).not.toContain(FIXTURE_KEY);

    const missingSigner = runScript(['--key-fp', '104867493888'], {
      SENTINEL_API_KEYS: `${FIXTURE_KEY}:direct:v3api`,
    });
    expect(missingSigner.status).toBe(2);
    expect(JSON.parse(missingSigner.stdout)).toMatchObject({
      mode: 'dry_run',
      status: 'public_key_missing',
      signer_status: 'public_key_missing',
      census_proves: CENSUS_PROVES,
      signer_binding_proven: false,
      authorizes_execution: false,
      keys: [{ key_fp: '104867493888', status: 'absent', authorizes_execution: false }],
    });
    expect(missingSigner.stdout).not.toContain(FIXTURE_KEY);

    const notYet = livePublicKey({
      notBefore: iso(Math.floor(Date.now() / 1000) + 3600),
      notAfter: iso(Math.floor(Date.now() / 1000) + 7200),
    });
    const closed = runScript(['--environment', 'production'], {
      SENTINEL_API_KEYS: `${FIXTURE_KEY}:direct:v3api`,
      SENTINEL_PRINCIPAL_PUBLIC_KEY: notYet.json,
    });
    expect(closed.status).toBe(2);
    expect(JSON.parse(closed.stdout)).toMatchObject({
      signer_status: 'WINDOW_INVALID',
      census_proves: 'api_key_account_mapping_only',
      signer_binding_proven: false,
    });
    expect(closed.stdout).not.toContain(notYet.x);
    expect(closed.stdout).not.toContain(FIXTURE_KEY);
  });

  it('refuses apply without a write when the fingerprint is absent, and hides arguments', () => {
    const signer = livePublicKey();
    const absent = runScript(
      ['--apply', '--environment', 'production', '--key-fp', '104867493888'],
      {
        SENTINEL_API_KEYS: `${FIXTURE_KEY}:direct:v3api`,
        SENTINEL_PRINCIPAL_PUBLIC_KEY: signer.json,
      },
    );
    expect(absent.status).toBe(2);
    expect(JSON.parse(absent.stdout)).toEqual({
      mode: 'apply',
      key_fp: '104867493888',
      status: 'absent',
      signer_status: 'valid',
      signer_fp: key_fp(signer.x),
      census_proves: 'api_key_account_mapping_only',
      signer_binding_proven: false,
      authorizes_execution: false,
    });
    expect(absent.stdout).not.toContain(FIXTURE_KEY);
    expect(absent.stdout).not.toContain(signer.x);
    expect(absent.stdout).not.toContain(CANARY);

    const malformed = runScript(
      ['--apply', '--environment', 'production', '--key-fp', '104867493888'],
      {
        SENTINEL_API_KEYS: `${FIXTURE_KEY}:direct:v3api`,
        SENTINEL_PRINCIPAL_PUBLIC_KEY: CANARY,
      },
    );
    expect(malformed.status).toBe(2);
    expect(JSON.parse(malformed.stdout)).toMatchObject({
      status: 'MALFORMED_REQUEST',
      signer_binding_proven: false,
    });
    expect(malformed.stdout).not.toContain(CANARY);
    expect(malformed.stdout).not.toContain(FIXTURE_KEY);

    const pasted = `sk_pasted_argument_${FIXTURE_KEY}`;
    const rejected = runScript(['--apply', pasted], {
      SENTINEL_API_KEYS: `${FIXTURE_KEY}:direct:v3api`,
    });
    expect(rejected.status).toBe(2);
    expect(rejected.stdout).toContain('"status":"unreadable"');
    expect(rejected.stdout).not.toContain(pasted);
    expect(rejected.stdout).not.toContain(FIXTURE_KEY);
    expect(rejected.stderr).not.toContain(pasted);
  });

  it('does not set the enforce flag, register a key, or skip ci', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const moduleSource = readFileSync(new URL('./mandate-key-account-pin.ts', import.meta.url), 'utf8');
    expect(script).toContain('applyApprovedKeyPin');
    expect(script).not.toContain('SENTINEL_MANDATE_PROOF_ENFORCE');
    expect(script).not.toContain('registerPrincipalKey');
    expect(script).not.toContain('console.log');
    expect(script).not.toContain('[skip ci]');
    expect(moduleSource).toContain('pinPrincipalKeyAsAdmin');
    expect(moduleSource).not.toContain('persistMigrationAccountPolicy');
    expect(moduleSource).not.toContain('registerPrincipalKey');
    expect(script).not.toContain('persistMigrationAccountPolicy');
    expect(moduleSource).not.toContain('[skip ci]');
    const store = readFileSync(new URL('./principal-manifest-store.ts', import.meta.url), 'utf8');
    expect(store).not.toContain('registerPrincipalKey');
    expect(store).not.toContain('[skip ci]');
  });
});
