/**
 * ADR-0023 admin pin path. `registerPrincipalKey` stays locked.
 * This function is the only writer, and only after an explicit grant
 * for the account and the action. It is not an HTTP route and it is
 * not called from POST /sentinel/verify.
 *
 * A result never authorizes execution. ACCEPTED is returned only after
 * a read-back shows the new key stored, active, and matching. A lost
 * write response is indeterminate: the audit omits counts and the call
 * is HTTP 503. Store and audit calls each have a monotonic deadline.
 * The audit entry is counts and status only: no account id, no kid,
 * no public key, no API key.
 */

import { createPublicKey } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  isPrincipalEnvironment,
  type PrincipalEnvironment,
  type PrincipalKeyManifest,
  type PrincipalPublicKey,
} from './principal-key-manifest.js';

/**
 * One store call or one audit call. Same budget as the manifest load
 * and the replay client. Not a clock for key validity.
 */
export const PRINCIPAL_ADMIN_CALL_DEADLINE_MS = 2_000;

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const RFC3339_UTC_SECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

const PRIVATE_KEY_FIELDS = new Set([
  'd',
  'k',
  'priv',
  'private',
  'privateKey',
  'private_key',
  'seed',
]);

const KEY_FIELDS = new Set([
  'kty',
  'crv',
  'x',
  'kid',
  'alg',
  'status',
  'notBefore',
  'notAfter',
]);

export const PRINCIPAL_ADMIN_AUDIT_REASONS = [
  'identity_unconfirmed',
  'admin_unauthorized',
  'possession_failed',
  'window_invalid',
  'environment_mismatch',
  'account_unmapped',
  'private_key_present',
  'malformed_request',
  'store_unavailable',
  'readback_failed',
  'version_mismatch',
  'state_unclear',
] as const;

export type PrincipalAdminAuditReason = (typeof PRINCIPAL_ADMIN_AUDIT_REASONS)[number];

export type PrincipalAdminAction = 'pin' | 'rotate_add';

export type PrincipalAdminPinCode =
  | 'ACCEPTED'
  | 'IDENTITY_UNCONFIRMED'
  | 'ADMIN_UNAUTHORIZED'
  | 'DUPLICATE_KEY'
  | 'ROTATED_KEY'
  | 'WINDOW_INVALID'
  | 'ENVIRONMENT_MISMATCH'
  | 'ACCOUNT_UNMAPPED'
  | 'PRIVATE_KEY_PRESENT'
  | 'MALFORMED_REQUEST'
  | 'STORE_UNAVAILABLE'
  | 'VERSION_MISMATCH'
  | 'STATE_UNCLEAR'
  | 'READBACK_FAILED'
  | 'FAILED';

export interface PrincipalAdminAuditEntry {
  action: PrincipalAdminAction;
  /**
   * `indeterminate` means the post-write state was not observed.
   * Counts are omitted. They are not the pre-write snapshot.
   */
  result: 'accepted' | 'rejected' | 'failed' | 'indeterminate';
  reason?: PrincipalAdminAuditReason;
  environment?: PrincipalEnvironment;
  keys_before?: number;
  keys_after?: number;
  active_after?: number;
  retired_after?: number;
  revoked_after?: number;
}

export interface PrincipalAdminPinResult {
  ok: boolean;
  code: PrincipalAdminPinCode;
  authorizesExecution: false;
  /** Present on every failure. Success is not an HTTP verdict. */
  httpStatus?: 503;
  audit: 'recorded' | 'audit_failed';
}

export type PrincipalAdminLoad =
  | { answered: true; version: string; manifest: unknown }
  | { answered: false };

export interface PrincipalAdminPinStore {
  load(accountId: string): Promise<PrincipalAdminLoad> | PrincipalAdminLoad;
  compareAndSet(
    accountId: string,
    expectedVersion: string,
    manifest: PrincipalKeyManifest,
  ): Promise<{ ok: true; version: string } | { ok: false }> | { ok: true; version: string } | { ok: false };
}

export interface PrincipalAdminPinInput {
  /** Explicit holder or account-admin grant. A verify API key is not this. */
  grant?: unknown;
  accountId?: unknown;
  environment?: unknown;
  /** Version read before this attempt. Mismatch does not write. */
  expectedVersion?: unknown;
  /** Public key to add. Status must be `active`. */
  key?: unknown;
  /** Receipt time, unix seconds. Not read from a clock here. */
  nowSeconds?: unknown;
  store?: PrincipalAdminPinStore | null;
  audit?: (entry: PrincipalAdminAuditEntry) => void | Promise<void>;
  /** Ignored. Not registration authority. */
  apiKey?: unknown;
  /** Ignored. Not registration authority. */
  agentIdHeader?: unknown;
}

interface KeyCounts {
  keys_before: number;
  keys_after: number;
  active_after: number;
  retired_after: number;
  revoked_after: number;
}

function closed(
  code: PrincipalAdminPinCode,
  audit: 'recorded' | 'audit_failed',
): PrincipalAdminPinResult {
  return {
    ok: false,
    httpStatus: 503,
    code,
    authorizesExecution: false,
    audit,
  };
}

function accepted(audit: 'recorded' | 'audit_failed'): PrincipalAdminPinResult {
  return {
    ok: audit === 'recorded',
    code: audit === 'recorded' ? 'ACCEPTED' : 'FAILED',
    authorizesExecution: false,
    ...(audit === 'recorded' ? {} : { httpStatus: 503 as const }),
    audit,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function unixFromIso(iso: string): number | null {
  if (!RFC3339_UTC_SECOND.test(iso)) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms % 1000 !== 0) return null;
  const roundTrip = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (roundTrip !== iso) return null;
  return ms / 1000;
}

function publicKeyOk(x: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(x)) return false;
  const raw = Buffer.from(x, 'base64url');
  if (raw.length !== 32) return false;
  if (raw.toString('base64url') !== x) return false;
  try {
    createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    return true;
  } catch {
    return false;
  }
}

function statusCounts(keys: readonly PrincipalPublicKey[]): {
  keys: number;
  active: number;
  retired: number;
  revoked: number;
} {
  let active = 0;
  let retired = 0;
  let revoked = 0;
  for (const key of keys) {
    if (key.status === 'active') active += 1;
    else if (key.status === 'retired') retired += 1;
    else if (key.status === 'revoked') revoked += 1;
  }
  return { keys: keys.length, active, retired, revoked };
}

function reasonFor(code: PrincipalAdminPinCode): PrincipalAdminAuditReason {
  switch (code) {
    case 'IDENTITY_UNCONFIRMED':
      return 'identity_unconfirmed';
    case 'ADMIN_UNAUTHORIZED':
      return 'admin_unauthorized';
    case 'DUPLICATE_KEY':
    case 'ROTATED_KEY':
    case 'MALFORMED_REQUEST':
      return 'malformed_request';
    case 'WINDOW_INVALID':
      return 'window_invalid';
    case 'ENVIRONMENT_MISMATCH':
      return 'environment_mismatch';
    case 'ACCOUNT_UNMAPPED':
      return 'account_unmapped';
    case 'PRIVATE_KEY_PRESENT':
      return 'private_key_present';
    case 'STORE_UNAVAILABLE':
      return 'store_unavailable';
    case 'READBACK_FAILED':
      return 'readback_failed';
    case 'VERSION_MISMATCH':
      return 'version_mismatch';
    case 'STATE_UNCLEAR':
    case 'FAILED':
    case 'ACCEPTED':
      return 'state_unclear';
    default: {
      const neverCode: never = code;
      void neverCode;
      return 'state_unclear';
    }
  }
}

function resultClass(code: PrincipalAdminPinCode): 'accepted' | 'rejected' | 'failed' {
  if (code === 'ACCEPTED') return 'accepted';
  if (
    code === 'STORE_UNAVAILABLE' ||
    code === 'VERSION_MISMATCH' ||
    code === 'STATE_UNCLEAR' ||
    code === 'READBACK_FAILED' ||
    code === 'FAILED'
  ) {
    return 'failed';
  }
  return 'rejected';
}

function buildEntry(
  action: PrincipalAdminAction,
  code: PrincipalAdminPinCode,
  environment: PrincipalEnvironment | undefined,
  counts: KeyCounts | undefined,
): PrincipalAdminAuditEntry {
  const result = resultClass(code);
  const entry: PrincipalAdminAuditEntry = { action, result };
  if (environment) entry.environment = environment;
  if (result !== 'accepted') entry.reason = reasonFor(code);
  if (!counts || code === 'STATE_UNCLEAR' || code === 'FAILED') return entry;
  entry.keys_before = counts.keys_before;
  entry.keys_after = counts.keys_after;
  entry.active_after = counts.active_after;
  entry.retired_after = counts.retired_after;
  entry.revoked_after = counts.revoked_after;
  return entry;
}

function withDeadline<T>(pending: Promise<T>, deadline: number): Promise<T> {
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
      finish(() => reject(new Error('principal_admin_deadline')));
    }, Math.max(0, deadline - performance.now()));
    pending.then(
      (value) => finish(() => {
        // A paused event loop can run this continuation after the timer.
        // Elapsed time, not callback order, decides expiry.
        if (performance.now() >= deadline) reject(new Error('principal_admin_deadline'));
        else resolve(value);
      }),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** Deadline starts before `run`, so synchronous work counts. */
async function withinDeadline<T>(run: () => Promise<T> | T): Promise<T> {
  const deadline = performance.now() + PRINCIPAL_ADMIN_CALL_DEADLINE_MS;
  return withDeadline(Promise.resolve(run()), deadline);
}

async function record(
  audit: (entry: PrincipalAdminAuditEntry) => void | Promise<void>,
  entry: PrincipalAdminAuditEntry,
): Promise<boolean> {
  try {
    await withinDeadline(() => audit(entry));
    return true;
  } catch {
    return false;
  }
}

function sameActiveKey(stored: PrincipalPublicKey, expected: PrincipalPublicKey): boolean {
  return stored.status === 'active'
    && expected.status === 'active'
    && stored.kid === expected.kid
    && stored.x === expected.x
    && stored.kty === expected.kty
    && stored.crv === expected.crv
    && stored.notBefore === expected.notBefore
    && stored.notAfter === expected.notAfter
    && (stored.alg ?? null) === (expected.alg ?? null);
}

function casCommitted(value: unknown, expectedVersion: string): boolean {
  if (!isPlainObject(value)) return false;
  return value.ok === true
    && typeof value.version === 'string'
    && value.version.length > 0
    && value.version !== expectedVersion;
}

function parseBound(value: unknown, allowNull: boolean): { ok: true; text: string | null } | { ok: false } {
  if (value === null && allowNull) return { ok: true, text: null };
  if (typeof value !== 'string') return { ok: false };
  if (unixFromIso(value) == null) return { ok: false };
  return { ok: true, text: value };
}

function parseStoredKey(entry: unknown): PrincipalPublicKey | null {
  if (!isPlainObject(entry)) return null;
  const names = Object.keys(entry);
  if (names.some((name) => PRIVATE_KEY_FIELDS.has(name))) return null;
  if (names.some((name) => !KEY_FIELDS.has(name))) return null;
  if (entry.kty !== 'OKP' || entry.crv !== 'Ed25519') return null;
  if (entry.alg !== undefined && entry.alg !== 'EdDSA') return null;
  if (typeof entry.kid !== 'string' || entry.kid.trim().length === 0 || entry.kid !== entry.kid.trim()) {
    return null;
  }
  if (typeof entry.x !== 'string' || !publicKeyOk(entry.x)) return null;
  if (entry.status !== 'active' && entry.status !== 'retired' && entry.status !== 'revoked') {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(entry, 'notBefore')) return null;
  if (!Object.prototype.hasOwnProperty.call(entry, 'notAfter')) return null;
  const notBefore = parseBound(entry.notBefore, true);
  const notAfter = parseBound(entry.notAfter, true);
  if (!notBefore.ok || !notAfter.ok) return null;
  const beforeUnix = notBefore.text == null ? null : unixFromIso(notBefore.text);
  const afterUnix = notAfter.text == null ? null : unixFromIso(notAfter.text);
  if (beforeUnix != null && afterUnix != null && afterUnix <= beforeUnix) return null;
  const key: PrincipalPublicKey = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: entry.x,
    kid: entry.kid,
    status: entry.status,
    notBefore: notBefore.text,
    notAfter: notAfter.text,
  };
  if (entry.alg === 'EdDSA') key.alg = 'EdDSA';
  return key;
}

function parseStoredManifest(
  accountId: string,
  manifest: unknown,
): { ok: true; keys: PrincipalPublicKey[] } | { ok: false } {
  if (manifest === null) return { ok: true, keys: [] };
  if (!isPlainObject(manifest)) return { ok: false };
  const top = Object.keys(manifest);
  if (top.some((key) => key !== 'accountId' && key !== 'keys')) return { ok: false };
  if (manifest.accountId !== accountId) return { ok: false };
  if (!Array.isArray(manifest.keys)) return { ok: false };
  const keys: PrincipalPublicKey[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.keys) {
    const key = parseStoredKey(entry);
    if (!key || seen.has(key.kid)) return { ok: false };
    seen.add(key.kid);
    keys.push(key);
  }
  return { ok: true, keys };
}

type NewKeyResult =
  | { ok: true; key: PrincipalPublicKey }
  | { ok: false; code: 'PRIVATE_KEY_PRESENT' | 'ROTATED_KEY' | 'MALFORMED_REQUEST' | 'WINDOW_INVALID' };

function parseNewKey(value: unknown, nowSeconds: number): NewKeyResult {
  if (!isPlainObject(value)) return { ok: false, code: 'MALFORMED_REQUEST' };
  const names = Object.keys(value);
  if (names.some((name) => PRIVATE_KEY_FIELDS.has(name))) {
    return { ok: false, code: 'PRIVATE_KEY_PRESENT' };
  }
  if (names.some((name) => !KEY_FIELDS.has(name))) return { ok: false, code: 'MALFORMED_REQUEST' };
  if (value.kty !== 'OKP' || value.crv !== 'Ed25519') return { ok: false, code: 'MALFORMED_REQUEST' };
  if (value.alg !== undefined && value.alg !== 'EdDSA') return { ok: false, code: 'MALFORMED_REQUEST' };
  if (typeof value.kid !== 'string' || value.kid.length === 0 || value.kid !== value.kid.trim()) {
    return { ok: false, code: 'MALFORMED_REQUEST' };
  }
  if (typeof value.x !== 'string' || !publicKeyOk(value.x)) return { ok: false, code: 'MALFORMED_REQUEST' };
  if (value.status === 'retired' || value.status === 'revoked' || value.status === 'rotated') {
    return { ok: false, code: 'ROTATED_KEY' };
  }
  if (value.status !== 'active') return { ok: false, code: 'MALFORMED_REQUEST' };
  if (typeof value.notBefore !== 'string' || typeof value.notAfter !== 'string') {
    return { ok: false, code: 'WINDOW_INVALID' };
  }
  const notBefore = unixFromIso(value.notBefore);
  const notAfter = unixFromIso(value.notAfter);
  if (notBefore == null || notAfter == null || notAfter <= notBefore) {
    return { ok: false, code: 'WINDOW_INVALID' };
  }
  if (nowSeconds < notBefore || nowSeconds >= notAfter) return { ok: false, code: 'WINDOW_INVALID' };
  const key: PrincipalPublicKey = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: value.x,
    kid: value.kid,
    status: 'active',
    notBefore: value.notBefore,
    notAfter: value.notAfter,
  };
  if (value.alg === 'EdDSA') key.alg = 'EdDSA';
  return { ok: true, key };
}

function readGrant(
  grant: unknown,
  accountId: string,
): { ok: true; actions: unknown[] } | { ok: false; code: 'IDENTITY_UNCONFIRMED' | 'ADMIN_UNAUTHORIZED' } {
  if (grant == null) return { ok: false, code: 'IDENTITY_UNCONFIRMED' };
  if (!isPlainObject(grant)) return { ok: false, code: 'IDENTITY_UNCONFIRMED' };
  if (grant.role !== 'account_admin' && grant.role !== 'account_holder') {
    return { ok: false, code: 'ADMIN_UNAUTHORIZED' };
  }
  if (grant.accountId !== accountId) return { ok: false, code: 'ADMIN_UNAUTHORIZED' };
  if (!Array.isArray(grant.actions)) return { ok: false, code: 'ADMIN_UNAUTHORIZED' };
  return { ok: true, actions: grant.actions };
}

function isLoad(value: unknown): value is PrincipalAdminLoad {
  if (!isPlainObject(value)) return false;
  if (value.answered === false) return true;
  return value.answered === true && typeof value.version === 'string';
}

/**
 * Pin one active public key, or add a replacement kid while the previous
 * key stays on the document. Normal callers, the verify API key, and
 * `X-Sentinel-Agent-Id` are not accepted here. `registerPrincipalKey`
 * is a different function and stays locked.
 */
export async function pinPrincipalKeyAsAdmin(
  input: PrincipalAdminPinInput,
): Promise<PrincipalAdminPinResult> {
  void input.apiKey;
  void input.agentIdHeader;

  const audit = typeof input.audit === 'function' ? input.audit : null;
  if (!audit) return closed('FAILED', 'audit_failed');

  let action: PrincipalAdminAction = 'pin';
  let environment: PrincipalEnvironment | undefined;
  let counts: KeyCounts | undefined;
  let attemptedWrite = false;

  const finish = async (code: PrincipalAdminPinCode): Promise<PrincipalAdminPinResult> => {
    if (code === 'STATE_UNCLEAR' || code === 'FAILED') counts = undefined;
    const entry = buildEntry(action, code, environment, counts);
    const recorded = await record(audit, entry);
    if (!recorded) return closed('FAILED', 'audit_failed');
    if (code === 'ACCEPTED') return accepted('recorded');
    return closed(code, 'recorded');
  };

  const indeterminate = async (
    reason: 'state_unclear' | 'readback_failed',
    code: PrincipalAdminPinCode,
  ): Promise<PrincipalAdminPinResult> => {
    const entry: PrincipalAdminAuditEntry = { action, result: 'indeterminate', reason };
    if (environment) entry.environment = environment;
    const recorded = await record(audit, entry);
    if (!recorded) return closed('FAILED', 'audit_failed');
    return closed(code, 'recorded');
  };

  try {
    if (isPrincipalEnvironment(input.environment)) environment = input.environment;
    else return finish('ENVIRONMENT_MISMATCH');

    if (typeof input.accountId !== 'string' || input.accountId.trim().length === 0) {
      return finish('ACCOUNT_UNMAPPED');
    }
    const accountId = input.accountId;
    const grant = readGrant(input.grant, accountId);
    if (!grant.ok) return finish(grant.code);

    if (!Number.isSafeInteger(input.nowSeconds) || (input.nowSeconds as number) < 0) {
      return finish('WINDOW_INVALID');
    }
    const nowSeconds = input.nowSeconds as number;

    if (typeof input.expectedVersion !== 'string' || input.expectedVersion.length === 0) {
      return finish('MALFORMED_REQUEST');
    }
    const expectedVersion = input.expectedVersion;

    const parsedKey = parseNewKey(input.key, nowSeconds);
    if (!parsedKey.ok) return finish(parsedKey.code);

    if (!input.store) return finish('STORE_UNAVAILABLE');
    const store = input.store;

    let loaded: unknown;
    try {
      loaded = await withinDeadline(() => store.load(accountId));
    } catch {
      return finish('STORE_UNAVAILABLE');
    }
    if (!isLoad(loaded) || loaded.answered === false) return finish('STORE_UNAVAILABLE');
    if (loaded.version.length === 0) return finish('STATE_UNCLEAR');
    if (loaded.version !== expectedVersion) return finish('VERSION_MISMATCH');

    const stored = parseStoredManifest(accountId, loaded.manifest);
    if (!stored.ok) return finish('STATE_UNCLEAR');

    const current = statusCounts(stored.keys);
    counts = {
      keys_before: current.keys,
      keys_after: current.keys,
      active_after: current.active,
      retired_after: current.retired,
      revoked_after: current.revoked,
    };

    action = stored.keys.length === 0 ? 'pin' : 'rotate_add';
    if (!grant.actions.includes(action)) return finish('ADMIN_UNAUTHORIZED');

    const sameKid = stored.keys.find((key) => key.kid === parsedKey.key.kid);
    if (sameKid) {
      return finish(sameKid.status === 'active' ? 'DUPLICATE_KEY' : 'ROTATED_KEY');
    }
    const sameX = stored.keys.find((key) => key.x === parsedKey.key.x);
    if (sameX) {
      return finish(sameX.status === 'active' ? 'DUPLICATE_KEY' : 'ROTATED_KEY');
    }

    const next: PrincipalKeyManifest = {
      accountId,
      keys: [...stored.keys, parsedKey.key],
    };

    let written: unknown;
    attemptedWrite = true;
    try {
      written = await withinDeadline(() => store.compareAndSet(accountId, expectedVersion, next));
    } catch {
      return indeterminate('state_unclear', 'STATE_UNCLEAR');
    }
    if (isPlainObject(written) && written.ok === false) {
      counts = undefined;
      return finish('VERSION_MISMATCH');
    }
    if (!casCommitted(written, expectedVersion)) {
      return indeterminate('state_unclear', 'STATE_UNCLEAR');
    }

    let again: unknown;
    try {
      again = await withinDeadline(() => store.load(accountId));
    } catch {
      return indeterminate('readback_failed', 'READBACK_FAILED');
    }
    if (!isLoad(again) || again.answered === false) {
      return indeterminate('readback_failed', 'READBACK_FAILED');
    }
    const confirmed = parseStoredManifest(accountId, again.manifest);
    if (!confirmed.ok) return indeterminate('state_unclear', 'STATE_UNCLEAR');
    const found = confirmed.keys.find((key) => key.kid === parsedKey.key.kid);
    if (!found || !sameActiveKey(found, parsedKey.key)) {
      const observed = statusCounts(confirmed.keys);
      counts = {
        keys_before: current.keys,
        keys_after: observed.keys,
        active_after: observed.active,
        retired_after: observed.retired,
        revoked_after: observed.revoked,
      };
      return finish('READBACK_FAILED');
    }
    const observed = statusCounts(confirmed.keys);
    counts = {
      keys_before: current.keys,
      keys_after: observed.keys,
      active_after: observed.active,
      retired_after: observed.retired,
      revoked_after: observed.revoked,
    };
    return finish('ACCEPTED');
  } catch {
    if (attemptedWrite) return indeterminate('state_unclear', 'STATE_UNCLEAR');
    try {
      const entry = buildEntry(action, 'FAILED', environment, undefined);
      const recorded = await record(audit, entry);
      return closed('FAILED', recorded ? 'recorded' : 'audit_failed');
    } catch {
      return closed('FAILED', 'audit_failed');
    }
  }
}
