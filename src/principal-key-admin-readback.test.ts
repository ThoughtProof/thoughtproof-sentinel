/**
 * Read-back, lost-write, and deadline regressions for the admin pin.
 * The earlier focused tests are not modified here.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  pinPrincipalKeyAsAdmin,
  PRINCIPAL_ADMIN_CALL_DEADLINE_MS,
  type PrincipalAdminAuditEntry,
  type PrincipalAdminPinStore,
} from './principal-key-admin.js';
import type { PrincipalKeyManifest, PrincipalPublicKey } from './principal-key-manifest.js';

const NOW = 1_800_000_000;
const ACCOUNT = 'acct-readback';
const pair = generateKeyPairSync('ed25519');

function okpX(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

const X = okpX(pair.publicKey);

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function submitted(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    x: X,
    kid: 'kid-readback',
    status: 'active',
    notBefore: iso(NOW - 1000),
    notAfter: iso(NOW + 1000),
    ...over,
  };
}

function emptyManifest(): PrincipalKeyManifest {
  return { accountId: ACCOUNT, keys: [] };
}

function pauseMainThread(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function baseInput(
  store: PrincipalAdminPinStore,
  audit: (entry: PrincipalAdminAuditEntry) => void | Promise<void>,
) {
  return {
    grant: { role: 'account_admin' as const, accountId: ACCOUNT, actions: ['pin'] },
    accountId: ACCOUNT,
    environment: 'production' as const,
    expectedVersion: 'v0',
    nowSeconds: NOW,
    key: submitted(),
    store,
    audit,
  };
}

describe('pinPrincipalKeyAsAdmin read-back', () => {
  it('does not accept a pin when the read-back does not contain the key', async () => {
    const entries: PrincipalAdminAuditEntry[] = [];
    const result = await pinPrincipalKeyAsAdmin(baseInput(
      {
        load() {
          return { answered: true, version: 'v0', manifest: emptyManifest() };
        },
        compareAndSet() {
          return { ok: true, version: 'v1' };
        },
      },
      (entry) => {
        entries.push(entry);
      },
    ));
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(503);
    expect(result.code).toBe('READBACK_FAILED');
    expect(result.authorizesExecution).toBe(false);
    expect(result).not.toHaveProperty('verdict');
    expect(entries[0]?.result).not.toBe('accepted');
    expect(entries[0]).toMatchObject({
      result: 'failed',
      reason: 'readback_failed',
      keys_after: 0,
    });
    expect(JSON.stringify(result)).not.toContain('ALLOW');
  });

  it('does not accept a pin when the read-back shows the key revoked', async () => {
    const revoked: PrincipalPublicKey = {
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      x: X,
      kid: 'kid-readback',
      status: 'revoked',
      notBefore: iso(NOW - 1000),
      notAfter: iso(NOW + 1000),
    };
    const entries: PrincipalAdminAuditEntry[] = [];
    let reads = 0;
    const result = await pinPrincipalKeyAsAdmin(baseInput(
      {
        load() {
          reads += 1;
          if (reads === 1) return { answered: true, version: 'v0', manifest: emptyManifest() };
          return { answered: true, version: 'v1', manifest: { accountId: ACCOUNT, keys: [revoked] } };
        },
        compareAndSet() {
          return { ok: true, version: 'v1' };
        },
      },
      (entry) => {
        entries.push(entry);
      },
    ));
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(503);
    expect(result.code).not.toBe('ACCEPTED');
    expect(entries[0]?.result).toBe('failed');
    expect(entries[0]?.revoked_after).toBe(1);
    expect(entries[0]?.active_after).toBe(0);
    expect(JSON.stringify(result)).not.toContain('ALLOW');
    expect(JSON.stringify(entries)).not.toContain(X);
  });

  it('fails closed when the read-back is missing or unavailable', async () => {
    const missingEntries: PrincipalAdminAuditEntry[] = [];
    let missingReads = 0;
    const missing = await pinPrincipalKeyAsAdmin(baseInput(
      {
        load() {
          missingReads += 1;
          if (missingReads === 1) return { answered: true, version: 'v0', manifest: emptyManifest() };
          return { answered: false };
        },
        compareAndSet() {
          return { ok: true, version: 'v1' };
        },
      },
      (entry) => {
        missingEntries.push(entry);
      },
    ));
    expect(missing).toMatchObject({
      ok: false,
      httpStatus: 503,
      code: 'READBACK_FAILED',
      authorizesExecution: false,
    });
    expect(missingEntries[0]).toMatchObject({ result: 'indeterminate', reason: 'readback_failed' });
    expect(missingEntries[0]).not.toHaveProperty('keys_after');

    const entries: PrincipalAdminAuditEntry[] = [];
    let reads = 0;
    const unavailable = await pinPrincipalKeyAsAdmin(baseInput(
      {
        load() {
          reads += 1;
          if (reads === 1) return { answered: true, version: 'v0', manifest: emptyManifest() };
          throw new Error('read-back down');
        },
        compareAndSet() {
          return { ok: true, version: 'v1' };
        },
      },
      (entry) => {
        entries.push(entry);
      },
    ));
    expect(unavailable).toMatchObject({
      ok: false,
      httpStatus: 503,
      code: 'READBACK_FAILED',
      authorizesExecution: false,
    });
    expect(entries[0]).toMatchObject({ result: 'indeterminate', reason: 'readback_failed' });
    expect(entries[0]).not.toHaveProperty('keys_before');
    expect(entries[0]).not.toHaveProperty('keys_after');
    expect(entries[0]).not.toHaveProperty('active_after');
    expect(JSON.stringify(unavailable)).not.toContain('read-back down');
    expect(JSON.stringify(entries)).not.toContain('ALLOW');
  });

  it('audits a lost write as indeterminate and does not report zero keys when the key was stored', async () => {
    const stored: PrincipalKeyManifest[] = [];
    const entries: PrincipalAdminAuditEntry[] = [];
    const result = await pinPrincipalKeyAsAdmin(baseInput(
      {
        load() {
          return { answered: true, version: 'v0', manifest: emptyManifest() };
        },
        compareAndSet(_accountId, _expected, manifest) {
          stored.push(manifest);
          throw new Error('response lost');
        },
      },
      (entry) => {
        entries.push(entry);
      },
    ));
    const saved = stored[0];
    if (!saved) throw new Error('key was not stored');
    expect(saved.keys).toHaveLength(1);
    expect(saved.keys[0]?.status).toBe('active');
    expect(saved.keys[0]?.kid).toBe('kid-readback');
    expect(result).toMatchObject({
      ok: false,
      httpStatus: 503,
      code: 'STATE_UNCLEAR',
      authorizesExecution: false,
    });
    expect(result.code).not.toBe('ACCEPTED');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      result: 'indeterminate',
      reason: 'state_unclear',
      environment: 'production',
    });
    expect(entries[0]).not.toHaveProperty('keys_before');
    expect(entries[0]).not.toHaveProperty('keys_after');
    expect(entries[0]).not.toHaveProperty('active_after');
    expect(entries[0]).not.toHaveProperty('retired_after');
    expect(entries[0]).not.toHaveProperty('revoked_after');
    expect(JSON.stringify(entries)).not.toContain('"keys_after":0');
    expect(JSON.stringify(entries)).not.toContain('"keys_before":0');
    expect(JSON.stringify(result)).not.toContain('response lost');
    expect(JSON.stringify(result)).not.toContain('ALLOW');
  });

  it('returns 503 within the deadline when the store hangs and ignores a late resolve', async () => {
    const started = performance.now();
    const hung = await pinPrincipalKeyAsAdmin(baseInput(
      {
        load: () => new Promise(() => undefined),
        compareAndSet() {
          throw new Error('must not write');
        },
      },
      () => undefined,
    ));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(PRINCIPAL_ADMIN_CALL_DEADLINE_MS - 20);
    expect(elapsed).toBeLessThan(PRINCIPAL_ADMIN_CALL_DEADLINE_MS + 1_500);
    expect(hung.ok).toBe(false);
    expect(hung.httpStatus).toBe(503);
    expect(hung.code).not.toBe('ACCEPTED');
    expect(hung.authorizesExecution).toBe(false);

    let writes = 0;
    const lateStarted = performance.now();
    const late = await pinPrincipalKeyAsAdmin(baseInput(
      {
        load() {
          pauseMainThread(PRINCIPAL_ADMIN_CALL_DEADLINE_MS + 150);
          return { answered: true, version: 'v0', manifest: emptyManifest() };
        },
        compareAndSet() {
          writes += 1;
          return { ok: true, version: 'v1' };
        },
      },
      () => undefined,
    ));
    expect(performance.now() - lateStarted).toBeGreaterThan(PRINCIPAL_ADMIN_CALL_DEADLINE_MS);
    expect(writes).toBe(0);
    expect(late.ok).toBe(false);
    expect(late.httpStatus).toBe(503);
    expect(late.code).not.toBe('ACCEPTED');
  }, 8_000);

  it('returns 503 within the deadline when the audit hangs and ignores a late resolve', async () => {
    const store: PrincipalAdminPinStore = {
      load() {
        return {
          answered: true,
          version: 'v1',
          manifest: {
            accountId: ACCOUNT,
            keys: [{
              kty: 'OKP',
              crv: 'Ed25519',
              alg: 'EdDSA',
              x: X,
              kid: 'kid-readback',
              status: 'active',
              notBefore: iso(NOW - 1000),
              notAfter: iso(NOW + 1000),
            }],
          },
        };
      },
      compareAndSet() {
        return { ok: true, version: 'v1' };
      },
    };
    // Initial load must be the empty manifest so the pin is not a duplicate.
    let reads = 0;
    store.load = () => {
      reads += 1;
      if (reads === 1) return { answered: true, version: 'v0', manifest: emptyManifest() };
      return {
        answered: true,
        version: 'v1',
        manifest: {
          accountId: ACCOUNT,
          keys: [{
            kty: 'OKP',
            crv: 'Ed25519',
            alg: 'EdDSA',
            x: X,
            kid: 'kid-readback',
            status: 'active',
            notBefore: iso(NOW - 1000),
            notAfter: iso(NOW + 1000),
          }],
        },
      };
    };

    const started = performance.now();
    const hung = await pinPrincipalKeyAsAdmin(baseInput(store, () => new Promise(() => undefined)));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(PRINCIPAL_ADMIN_CALL_DEADLINE_MS - 20);
    expect(elapsed).toBeLessThan(PRINCIPAL_ADMIN_CALL_DEADLINE_MS + 1_500);
    expect(hung.ok).toBe(false);
    expect(hung.httpStatus).toBe(503);
    expect(hung.code).not.toBe('ACCEPTED');
    expect(hung.audit).toBe('audit_failed');

    reads = 0;
    const lateStarted = performance.now();
    const late = await pinPrincipalKeyAsAdmin(baseInput(store, () => {
      pauseMainThread(PRINCIPAL_ADMIN_CALL_DEADLINE_MS + 150);
    }));
    expect(performance.now() - lateStarted).toBeGreaterThan(PRINCIPAL_ADMIN_CALL_DEADLINE_MS);
    expect(late.ok).toBe(false);
    expect(late.httpStatus).toBe(503);
    expect(late.code).not.toBe('ACCEPTED');
    expect(late.authorizesExecution).toBe(false);
  }, 8_000);
});
