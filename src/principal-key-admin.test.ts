/**
 * Admin-only principal key pin. registerPrincipalKey stays locked.
 * Negative cases: non-admin, missing auth, duplicate key, rotated key.
 * Offline. No network and no provider keys.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  pinPrincipalKeyAsAdmin,
  type PrincipalAdminAuditEntry,
  type PrincipalAdminPinResult,
  type PrincipalAdminPinStore,
} from './principal-key-admin.js';
import {
  registerPrincipalKey,
  verifyPrincipalMandate,
  verdictWithPrincipalCheck,
  type PrincipalKeyManifest,
  type PrincipalProofFields,
  type PrincipalPublicKey,
  type PrincipalRegistrationAttempt,
  PRINCIPAL_MANDATE_PURPOSE,
  PRINCIPAL_MANDATE_SCHEMA,
  principalMandateSignedBytes,
} from './principal-key-manifest.js';

const NOW = 1_800_000_000;
const ACCOUNT = 'acct-admin-pin';
const OTHER = 'acct-admin-other';
const API_KEY = 'sk_admin_fixture';
const AGENT = 'agent-admin-header';
const PRIVATE_FIELD = 'not-a-real-seed';

const retiredPair = generateKeyPairSync('ed25519');
const revokedPair = generateKeyPairSync('ed25519');
const freshPair = generateKeyPairSync('ed25519');

function okpX(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

const RETIRED_X = okpX(retiredPair.publicKey);
const REVOKED_X = okpX(revokedPair.publicKey);
const FRESH_X = okpX(freshPair.publicKey);

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function publicKey(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    x: FRESH_X,
    kid: 'kid-fresh',
    status: 'active',
    notBefore: iso(NOW - 1000),
    notAfter: iso(NOW + 1000),
    ...over,
  };
}

function storedKey(over: Partial<PrincipalPublicKey>): PrincipalPublicKey {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    x: RETIRED_X,
    kid: 'kid-retired',
    status: 'retired',
    notBefore: iso(NOW - 5000),
    notAfter: iso(NOW + 5000),
    ...over,
  };
}

function grant(over: Record<string, unknown> = {}) {
  return {
    role: 'account_admin',
    accountId: ACCOUNT,
    actions: ['pin', 'rotate_add'],
    ...over,
  };
}

function memory(manifest: unknown, version = 'v0') {
  let current = { version, manifest };
  let cas = 0;
  const store: PrincipalAdminPinStore = {
    load() {
      return { answered: true as const, version: current.version, manifest: current.manifest };
    },
    compareAndSet(_accountId, expected, next) {
      cas += 1;
      if (expected !== current.version) return { ok: false as const };
      current = { version: `${current.version}-2`, manifest: next };
      return { ok: true as const, version: current.version };
    },
  };
  return {
    store,
    cas: () => cas,
    snapshot: () => current,
  };
}

function capture() {
  const entries: PrincipalAdminAuditEntry[] = [];
  return {
    entries,
    audit(entry: PrincipalAdminAuditEntry) {
      entries.push(entry);
    },
  };
}

function expectClosed(result: PrincipalAdminPinResult, code: string): void {
  expect(result.ok).toBe(false);
  expect(result.httpStatus).toBe(503);
  expect(result.code).toBe(code);
  expect(result.authorizesExecution).toBe(false);
  expect(result).not.toHaveProperty('verdict');
  expect(JSON.stringify(result)).not.toContain('ALLOW');
}

function expectAuditClean(entries: PrincipalAdminAuditEntry[]): void {
  const json = JSON.stringify(entries);
  expect(json).not.toContain(ACCOUNT);
  expect(json).not.toContain(OTHER);
  expect(json).not.toContain(API_KEY);
  expect(json).not.toContain(AGENT);
  expect(json).not.toContain(PRIVATE_FIELD);
  expect(json).not.toContain(FRESH_X);
  expect(json).not.toContain(RETIRED_X);
  expect(json).not.toContain(REVOKED_X);
  expect(json).not.toContain('kid-fresh');
  expect(json).not.toContain('kid-retired');
  expect(json).not.toContain('kid-revoked');
  expect(json).not.toContain('ALLOW');
  for (const entry of entries) {
    expect(entry).not.toHaveProperty('accountId');
    expect(entry).not.toHaveProperty('kid');
    expect(entry).not.toHaveProperty('x');
    expect(entry).not.toHaveProperty('apiKey');
  }
}

describe('pinPrincipalKeyAsAdmin', () => {
  it('rejects missing auth and a non-admin before any write', async () => {
    const box = memory({ accountId: ACCOUNT, keys: [] });
    const log = capture();
    const missing = await pinPrincipalKeyAsAdmin({
      apiKey: API_KEY,
      agentIdHeader: AGENT,
      accountId: ACCOUNT,
      environment: 'production',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey(),
      store: box.store,
      audit: log.audit,
    });
    expectClosed(missing, 'IDENTITY_UNCONFIRMED');
    expect(box.cas()).toBe(0);
    expect(log.entries).toEqual([
      { action: 'pin', result: 'rejected', reason: 'identity_unconfirmed', environment: 'production' },
    ]);

    const operator = await pinPrincipalKeyAsAdmin({
      grant: grant({ role: 'operator' }),
      apiKey: API_KEY,
      accountId: ACCOUNT,
      environment: 'production',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey(),
      store: box.store,
      audit: log.audit,
    });
    expectClosed(operator, 'ADMIN_UNAUTHORIZED');

    const otherAccount = await pinPrincipalKeyAsAdmin({
      grant: grant({ accountId: OTHER }),
      accountId: ACCOUNT,
      environment: 'production',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey(),
      store: box.store,
      audit: log.audit,
    });
    expectClosed(otherAccount, 'ADMIN_UNAUTHORIZED');

    const noAction = await pinPrincipalKeyAsAdmin({
      grant: grant({ actions: ['retire'] }),
      accountId: ACCOUNT,
      environment: 'production',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey(),
      store: box.store,
      audit: log.audit,
    });
    expectClosed(noAction, 'ADMIN_UNAUTHORIZED');
    expect(box.cas()).toBe(0);
    expect(log.entries[3]).toMatchObject({
      action: 'pin',
      result: 'rejected',
      reason: 'admin_unauthorized',
      keys_before: 0,
      keys_after: 0,
    });
    expectAuditClean(log.entries);
    expect(JSON.stringify(missing)).not.toContain(API_KEY);
  });

  it('rejects a duplicate active key and a rotated key without writing', async () => {
    const manifest = {
      accountId: ACCOUNT,
      keys: [
        storedKey({ kid: 'kid-active', status: 'active', x: RETIRED_X }),
        storedKey({ kid: 'kid-retired', status: 'retired', x: REVOKED_X }),
        storedKey({ kid: 'kid-revoked', status: 'revoked', x: FRESH_X }),
      ],
    };
    const box = memory(manifest);
    const log = capture();
    const duplicate = await pinPrincipalKeyAsAdmin({
      grant: grant(),
      accountId: ACCOUNT,
      environment: 'preview',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey({ kid: 'kid-active', x: okpX(generateKeyPairSync('ed25519').publicKey) }),
      store: box.store,
      audit: log.audit,
    });
    expectClosed(duplicate, 'DUPLICATE_KEY');
    expect(log.entries[0]).toMatchObject({
      action: 'rotate_add',
      result: 'rejected',
      reason: 'malformed_request',
      environment: 'preview',
      keys_before: 3,
      keys_after: 3,
      active_after: 1,
      retired_after: 1,
      revoked_after: 1,
    });

    const rotatedSameX = await pinPrincipalKeyAsAdmin({
      grant: grant(),
      accountId: ACCOUNT,
      environment: 'preview',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey({ kid: 'kid-replacement', x: REVOKED_X }),
      store: box.store,
      audit: log.audit,
    });
    expectClosed(rotatedSameX, 'ROTATED_KEY');

    const rotatedStatus = await pinPrincipalKeyAsAdmin({
      grant: grant(),
      accountId: ACCOUNT,
      environment: 'preview',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey({
        kid: 'kid-status',
        x: okpX(generateKeyPairSync('ed25519').publicKey),
        status: 'rotated',
      }),
      store: box.store,
      audit: log.audit,
    });
    expectClosed(rotatedStatus, 'ROTATED_KEY');

    const rotatedKid = await pinPrincipalKeyAsAdmin({
      grant: grant(),
      accountId: ACCOUNT,
      environment: 'preview',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey({
        kid: 'kid-revoked',
        x: okpX(generateKeyPairSync('ed25519').publicKey),
      }),
      store: box.store,
      audit: log.audit,
    });
    expectClosed(rotatedKid, 'ROTATED_KEY');
    expect(box.cas()).toBe(0);
    expect(box.snapshot().version).toBe('v0');
    expectAuditClean(log.entries);
  });

  it('fails closed when the store, the audit log, or the window errors', async () => {
    const log = capture();
    const thrown = await pinPrincipalKeyAsAdmin({
      grant: grant(),
      accountId: ACCOUNT,
      environment: 'production',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey(),
      store: {
        load() {
          throw new Error('store down');
        },
        compareAndSet() {
          throw new Error('should not write');
        },
      },
      audit: log.audit,
    });
    expectClosed(thrown, 'STORE_UNAVAILABLE');
    expect(log.entries[0]?.reason).toBe('store_unavailable');
    expect(JSON.stringify(thrown)).not.toContain('store down');

    const mismatch = memory({ accountId: ACCOUNT, keys: [] });
    const wrongVersion = await pinPrincipalKeyAsAdmin({
      grant: grant(),
      accountId: ACCOUNT,
      environment: 'production',
      expectedVersion: 'stale',
      nowSeconds: NOW,
      key: publicKey(),
      store: mismatch.store,
      audit: log.audit,
    });
    expectClosed(wrongVersion, 'VERSION_MISMATCH');
    expect(mismatch.cas()).toBe(0);

    let cas = 0;
    const auditDown = await pinPrincipalKeyAsAdmin({
      grant: grant(),
      accountId: ACCOUNT,
      environment: 'production',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey({ d: PRIVATE_FIELD }),
      store: {
        load() {
          return { answered: true as const, version: 'v0', manifest: { accountId: ACCOUNT, keys: [] } };
        },
        compareAndSet() {
          cas += 1;
          return { ok: true as const, version: 'v1' };
        },
      },
      audit() {
        throw new Error('audit down');
      },
    });
    expect(auditDown.ok).toBe(false);
    expect(auditDown.httpStatus).toBe(503);
    expect(auditDown.authorizesExecution).toBe(false);
    expect(auditDown.audit).toBe('audit_failed');
    expect(cas).toBe(0);
    expect(JSON.stringify(auditDown)).not.toContain(PRIVATE_FIELD);
    expect(JSON.stringify(auditDown)).not.toContain('ALLOW');

    let wrote = 0;
    const afterWrite = await pinPrincipalKeyAsAdmin({
      grant: grant(),
      accountId: ACCOUNT,
      environment: 'production',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey(),
      store: {
        load() {
          return { answered: true as const, version: 'v0', manifest: { accountId: ACCOUNT, keys: [] } };
        },
        compareAndSet() {
          wrote += 1;
          return { ok: true as const, version: 'v1' };
        },
      },
      audit() {
        throw new Error('audit after write');
      },
    });
    expect(afterWrite).toMatchObject({
      ok: false,
      httpStatus: 503,
      code: 'FAILED',
      authorizesExecution: false,
      audit: 'audit_failed',
    });
    expect(afterWrite).not.toHaveProperty('verdict');
    expect(wrote).toBe(1);
    expect(JSON.stringify(afterWrite)).not.toContain('audit after write');
    expect(JSON.stringify(afterWrite)).not.toContain('ALLOW');

    const privateKey = await pinPrincipalKeyAsAdmin({
      grant: grant(),
      accountId: ACCOUNT,
      environment: 'production',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey({ d: PRIVATE_FIELD }),
      store: mismatch.store,
      audit: log.audit,
    });
    expectClosed(privateKey, 'PRIVATE_KEY_PRESENT');
    expect(JSON.stringify(log.entries)).not.toContain(PRIVATE_FIELD);

    const badWindow = await pinPrincipalKeyAsAdmin({
      grant: grant(),
      accountId: ACCOUNT,
      environment: 'development',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey({ notBefore: '2026-02-30T00:00:00Z', notAfter: iso(NOW + 10) }),
      store: mismatch.store,
      audit: log.audit,
    });
    expectClosed(badWindow, 'WINDOW_INVALID');

    const badEnv = await pinPrincipalKeyAsAdmin({
      grant: grant(),
      accountId: ACCOUNT,
      environment: 'Production',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey(),
      store: mismatch.store,
      audit: log.audit,
    });
    expectClosed(badEnv, 'ENVIRONMENT_MISMATCH');
    expect(log.entries.at(-1)).not.toHaveProperty('environment');
    expectAuditClean(log.entries);
  });

  it('pins a replacement during overlap and leaves retired and revoked keys in place', async () => {
    const manifest: PrincipalKeyManifest = {
      accountId: ACCOUNT,
      keys: [
        storedKey({ kid: 'kid-retired', status: 'retired', x: RETIRED_X }),
        storedKey({ kid: 'kid-revoked', status: 'revoked', x: REVOKED_X }),
      ],
    };
    const box = memory(manifest);
    const log = capture();
    const result = await pinPrincipalKeyAsAdmin({
      grant: grant({ role: 'account_holder' }),
      apiKey: API_KEY,
      agentIdHeader: AGENT,
      accountId: ACCOUNT,
      environment: 'production',
      expectedVersion: 'v0',
      nowSeconds: NOW,
      key: publicKey(),
      store: box.store,
      audit: log.audit,
    });
    expect(result).toEqual({
      ok: true,
      code: 'ACCEPTED',
      authorizesExecution: false,
      audit: 'recorded',
    });
    expect(result).not.toHaveProperty('verdict');
    expect(result).not.toHaveProperty('httpStatus');
    expect(box.cas()).toBe(1);
    expect(log.entries).toEqual([
      {
        action: 'rotate_add',
        result: 'accepted',
        environment: 'production',
        keys_before: 2,
        keys_after: 3,
        active_after: 1,
        retired_after: 1,
        revoked_after: 1,
      },
    ]);
    expectAuditClean(log.entries);

    const saved = box.snapshot().manifest as PrincipalKeyManifest;
    expect(saved.keys.map((key) => key.status)).toEqual(['retired', 'revoked', 'active']);
    const store = {
      load() {
        return { answered: true as const, manifest: saved };
      },
    };
    const fields = (kid: string): PrincipalProofFields => ({
      schema_version: PRINCIPAL_MANDATE_SCHEMA,
      nonce: 'nonce-admin-pin',
      iat: NOW,
      exp: NOW + 60,
      account_id: ACCOUNT,
      environment: 'production',
      purpose: PRINCIPAL_MANDATE_PURPOSE,
      principal_kid: kid,
    });
    const mandate = { action: 'status' };
    function proof(privateKey: KeyObject, kid: string) {
      const body = fields(kid);
      const bytes = principalMandateSignedBytes(mandate, body);
      if (!bytes) throw new Error('fixture bytes were not produced');
      return { ...body, signature: sign(null, bytes, privateKey).toString('hex') };
    }
    const active = await verifyPrincipalMandate({
      authenticatedAccountId: ACCOUNT,
      mandate,
      mandateProof: proof(freshPair.privateKey, 'kid-fresh'),
      nowSeconds: NOW,
      targetEnvironment: 'production',
      store,
    });
    expect(active).toMatchObject({ ok: true, mandateSource: 'principal_signed', principalKid: 'kid-fresh' });
    expect(active).not.toHaveProperty('verdict');

    const retired = await verifyPrincipalMandate({
      authenticatedAccountId: ACCOUNT,
      mandate,
      mandateProof: proof(retiredPair.privateKey, 'kid-retired'),
      nowSeconds: NOW,
      targetEnvironment: 'production',
      store,
    });
    expect(retired).toEqual({ ok: false, verdict: 'BLOCK', reason: 'retired' });
    expect(verdictWithPrincipalCheck('ALLOW', retired)).toBe('BLOCK');

    const revoked = await verifyPrincipalMandate({
      authenticatedAccountId: ACCOUNT,
      mandate,
      mandateProof: proof(revokedPair.privateKey, 'kid-revoked'),
      nowSeconds: NOW,
      targetEnvironment: 'production',
      store,
    });
    expect(revoked).toEqual({ ok: false, verdict: 'BLOCK', reason: 'revoked' });
    expect(verdictWithPrincipalCheck('ALLOW', revoked)).toBe('BLOCK');
    expect(JSON.stringify(result)).not.toContain('ALLOW');
  });

  it('keeps registerPrincipalKey locked and stays off the verify handler', async () => {
    let writes = 0;
    const attempt = {
      apiKey: API_KEY,
      agentIdHeader: AGENT,
      accountId: ACCOUNT,
      manifest: { accountId: ACCOUNT, keys: [] },
      write: () => {
        writes += 1;
      },
    } as PrincipalRegistrationAttempt;
    const locked = registerPrincipalKey(attempt);
    expect(locked).toEqual({ ok: false, httpStatus: 503, code: 'REGISTRATION_UNAUTHORIZED' });
    expect(writes).toBe(0);
    expect(JSON.stringify(locked)).not.toContain('ALLOW');

    const verify = readFileSync(new URL('../api/sentinel/verify.ts', import.meta.url), 'utf8');
    const requestPath = readFileSync(new URL('./mandate-request-path.ts', import.meta.url), 'utf8');
    expect(verify).not.toContain('pinPrincipalKeyAsAdmin');
    expect(verify).not.toContain('principal-key-admin');
    expect(requestPath).not.toContain('pinPrincipalKeyAsAdmin');
    expect(requestPath).not.toContain('principal-key-admin');
    expect(verify).not.toContain('[skip ci]');
  });
});
