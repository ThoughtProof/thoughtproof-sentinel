/**
 * Productive principal manifest and account policy on the existing
 * Upstash Redis. This is not a memory store and it is not the
 * rate-limit client. A missing client, a bad reply, a throw, or a
 * silent call past the deadline is a closed failure. It is not legacy
 * and it is not an empty manifest that verifies.
 *
 * This module does not set SENTINEL_MANDATE_PROOF_ENFORCE and it does
 * not authorize execution. `legacy` for the three migration accounts
 * is an explicit policy when Redis answers that no row is stored. It
 * is not protected-account enablement. An error does not use that
 * policy.
 */

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Redis } from '@upstash/redis';
import type { PrincipalKeyManifest, PrincipalEnvironment } from './principal-key-manifest.js';
import { isPrincipalEnvironment } from './principal-key-manifest.js';
import type { PrincipalAdminLoad, PrincipalAdminPinStore } from './principal-key-admin.js';
import { resolveUpstashConfig } from './upstash-env.js';

/** Same budget as the manifest load, the replay client, and the admin pin. */
export const PRINCIPAL_STORE_DEADLINE_MS = 2_000;

const MANIFEST_PREFIX = 'sentinel:principal-manifest:v1:';
const POLICY_PREFIX = 'sentinel:account-policy:v1:';

/**
 * Owner-chosen accounts. Readable only after Redis answers. A stored
 * `legacy` or `protected` row wins. A missing row is this explicit
 * `legacy` status. Any error is unreadable, including for these accounts.
 * The agent id is not the account id.
 */
export const MIGRATION_ACCOUNT_POLICIES = {
  acct_v3api: 'legacy',
  acct_grokbot: 'legacy',
  acct_nightly: 'legacy',
} as const;

export type MigrationAccountId = keyof typeof MIGRATION_ACCOUNT_POLICIES;
export type StoredAccountPolicy = 'legacy' | 'protected';
export type AccountPolicyRead = StoredAccountPolicy | 'unreadable';

export const PRINCIPAL_MANIFEST_LOAD_SCRIPT = `
local ver = redis.call('HGET', KEYS[1], 'version')
local man = redis.call('HGET', KEYS[1], 'manifest')
if not ver then
  return 'empty'
end
if type(ver) ~= 'string' or type(man) ~= 'string' then
  return 'bad'
end
return 'doc\\n' .. ver .. '\\n' .. man
`.trim();

export const PRINCIPAL_MANIFEST_CAS_SCRIPT = `
local expected = ARGV[1]
local document = ARGV[2]
if type(expected) ~= 'string' or string.match(expected, '^%d+$') == nil then
  return 'bad'
end
if type(document) ~= 'string' or #document == 0 then
  return 'bad'
end
local ver = redis.call('HGET', KEYS[1], 'version')
if not ver then ver = '0' end
if ver ~= expected then
  return 'mismatch'
end
local n = tonumber(ver)
if n == nil then
  return 'bad'
end
local nxt = tostring(n + 1)
redis.call('HSET', KEYS[1], 'version', nxt, 'manifest', document)
return 'ok:' .. nxt
`.trim();

export const ACCOUNT_POLICY_LOAD_SCRIPT = `
local ver = redis.call('HGET', KEYS[1], 'version')
local status = redis.call('HGET', KEYS[1], 'status')
if not ver and not status then
  return 'missing'
end
if type(ver) ~= 'string' or type(status) ~= 'string' then
  return 'bad'
end
return 'doc\\n' .. ver .. '\\n' .. status
`.trim();

export const ACCOUNT_POLICY_CAS_SCRIPT = `
local expected = ARGV[1]
local status = ARGV[2]
if type(expected) ~= 'string' or string.match(expected, '^%d+$') == nil then
  return 'bad'
end
if status ~= 'legacy' and status ~= 'protected' then
  return 'bad'
end
local ver = redis.call('HGET', KEYS[1], 'version')
if not ver then ver = '0' end
if ver ~= expected then
  return 'mismatch'
end
local n = tonumber(ver)
if n == nil then
  return 'bad'
end
local nxt = tostring(n + 1)
redis.call('HSET', KEYS[1], 'version', nxt, 'status', status)
return 'ok:' .. nxt
`.trim();

export interface PrincipalRedisCommand {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export interface ProductiveStoreInput {
  environment: PrincipalEnvironment | undefined;
  env?: Record<string, unknown>;
  /** Omit to use the dedicated client. `null` is an unavailable store. */
  command?: PrincipalRedisCommand | null;
}

interface PolicyRecord {
  ok: true;
  present: false;
}

interface StoredPolicyRecord {
  ok: true;
  present: true;
  version: string;
  status: StoredAccountPolicy;
}

type PolicyLoad = PolicyRecord | StoredPolicyRecord | { ok: false };

let cachedClient: { key: string; command: PrincipalRedisCommand } | null = null;

function unavailableError(): Error {
  return new Error('principal_store_unavailable');
}

function toProcessEnv(env: Record<string, unknown>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

function redisKey(prefix: string, environment: string, accountId: string): string {
  const digest = createHash('sha256')
    .update(prefix, 'utf8')
    .update('\0', 'utf8')
    .update(environment, 'utf8')
    .update('\0', 'utf8')
    .update(accountId, 'utf8')
    .digest('hex');
  return prefix + digest;
}

export function isMigrationAccount(accountId: string): accountId is MigrationAccountId {
  return Object.prototype.hasOwnProperty.call(MIGRATION_ACCOUNT_POLICIES, accountId);
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
      finish(() => reject(unavailableError()));
    }, Math.max(0, deadline - performance.now()));
    pending.then(
      (value) => finish(() => {
        if (performance.now() >= deadline) reject(unavailableError());
        else resolve(value);
      }),
      () => finish(() => reject(unavailableError())),
    );
  });
}

async function evalWithin(
  command: PrincipalRedisCommand,
  script: string,
  keys: string[],
  args: string[],
): Promise<unknown> {
  const deadline = performance.now() + PRINCIPAL_STORE_DEADLINE_MS;
  return withDeadline(Promise.resolve().then(() => command.eval(script, keys, args)), deadline);
}

/** Dedicated no-retry client. Missing or invalid config is unavailable. */
export function principalRedisCommand(env: Record<string, unknown> = process.env): PrincipalRedisCommand | null {
  try {
    const cfg = resolveUpstashConfig(toProcessEnv(env));
    if (cfg.status !== 'configured') return null;
    const key = `${cfg.url}\0${cfg.token.length}`;
    if (!cachedClient || cachedClient.key !== key) {
      const redis = new Redis({
        url: cfg.url,
        token: cfg.token,
        automaticDeserialization: false,
        enableTelemetry: false,
        retry: { retries: 0 },
      });
      cachedClient = {
        key,
        command: {
          eval(script, keys, args) {
            return redis.createScript<unknown>(script).eval(keys, args);
          },
        },
      };
    }
    return cachedClient.command;
  } catch {
    return null;
  }
}

function resolveCommand(input: ProductiveStoreInput): PrincipalRedisCommand | null {
  if (!isPrincipalEnvironment(input.environment)) return null;
  if (input.command === null) return null;
  if (input.command) return input.command;
  return principalRedisCommand(input.env ?? process.env);
}

function closedStore(): PrincipalAdminPinStore {
  return {
    async load(): Promise<PrincipalAdminLoad> {
      return { answered: false };
    },
    async compareAndSet(): Promise<{ ok: false }> {
      throw unavailableError();
    },
  };
}

function parseManifestReply(raw: unknown): PrincipalAdminLoad | null {
  if (raw === 'empty') return { answered: true, version: '0', manifest: null };
  if (typeof raw !== 'string' || !raw.startsWith('doc\n')) return null;
  const rest = raw.slice('doc\n'.length);
  const splitAt = rest.indexOf('\n');
  if (splitAt <= 0) return null;
  const version = rest.slice(0, splitAt);
  const document = rest.slice(splitAt + 1);
  if (!/^\d+$/.test(version) || document.length === 0) return null;
  try {
    const manifest: unknown = JSON.parse(document);
    return { answered: true, version, manifest };
  } catch {
    return null;
  }
}

function parsePolicyReply(raw: unknown): PolicyLoad {
  if (raw === 'missing') return { ok: true, present: false };
  if (typeof raw !== 'string' || !raw.startsWith('doc\n')) return { ok: false };
  const rest = raw.slice('doc\n'.length);
  const splitAt = rest.indexOf('\n');
  if (splitAt <= 0) return { ok: false };
  const version = rest.slice(0, splitAt);
  const status = rest.slice(splitAt + 1);
  if (!/^\d+$/.test(version)) return { ok: false };
  if (status !== 'legacy' && status !== 'protected') return { ok: false };
  return { ok: true, present: true, version, status };
}

function manifestDocument(accountId: string, manifest: PrincipalKeyManifest): string {
  if (manifest.accountId !== accountId || !Array.isArray(manifest.keys)) {
    throw unavailableError();
  }
  return JSON.stringify(manifest);
}

/**
 * Manifest store for one environment. `load` answers `{ answered: false }`
 * on every failure. An absent document answers version `0` and a null
 * manifest, which is an empty account, not a verified key.
 */
export function createProductiveManifestStore(input: ProductiveStoreInput): PrincipalAdminPinStore {
  const environment = input.environment;
  const command = resolveCommand(input);
  if (!environment || !command) return closedStore();
  const envName = environment;
  const redis = command;
  return {
    async load(accountId: string): Promise<PrincipalAdminLoad> {
      if (typeof accountId !== 'string' || accountId.length === 0) return { answered: false };
      try {
        const raw = await evalWithin(
          redis,
          PRINCIPAL_MANIFEST_LOAD_SCRIPT,
          [redisKey(MANIFEST_PREFIX, envName, accountId)],
          [],
        );
        return parseManifestReply(raw) ?? { answered: false };
      } catch {
        return { answered: false };
      }
    },
    async compareAndSet(accountId, expectedVersion, manifest) {
      if (typeof accountId !== 'string' || accountId.length === 0) throw unavailableError();
      if (typeof expectedVersion !== 'string' || !/^\d+$/.test(expectedVersion)) throw unavailableError();
      const document = manifestDocument(accountId, manifest);
      const raw = await evalWithin(
        redis,
        PRINCIPAL_MANIFEST_CAS_SCRIPT,
        [redisKey(MANIFEST_PREFIX, envName, accountId)],
        [expectedVersion, document],
      );
      if (raw === 'mismatch') return { ok: false };
      if (typeof raw === 'string' && raw.startsWith('ok:')) {
        const version = raw.slice('ok:'.length);
        if (/^\d+$/.test(version) && version !== expectedVersion) return { ok: true, version };
      }
      throw unavailableError();
    },
  };
}

async function loadPolicyRecord(
  accountId: string,
  environment: PrincipalEnvironment,
  command: PrincipalRedisCommand,
): Promise<PolicyLoad> {
  if (accountId.length === 0) return { ok: false };
  try {
    const raw = await evalWithin(
      command,
      ACCOUNT_POLICY_LOAD_SCRIPT,
      [redisKey(POLICY_PREFIX, environment, accountId)],
      [],
    );
    return parsePolicyReply(raw);
  } catch {
    return { ok: false };
  }
}

/**
 * Account policy. The three migration accounts are `legacy` when Redis
 * answers that the row is absent. A stored `legacy` or `protected` value
 * is returned as stored. Every error, including a timeout, is
 * `unreadable` for those accounts and for every other account.
 */
export async function readProductiveAccountPolicy(
  accountId: string,
  input: ProductiveStoreInput,
): Promise<AccountPolicyRead> {
  if (typeof accountId !== 'string') return 'unreadable';
  const command = resolveCommand(input);
  if (!input.environment || !command) return 'unreadable';
  const record = await loadPolicyRecord(accountId, input.environment, command);
  if (!record.ok) return 'unreadable';
  if (record.present) return record.status;
  if (isMigrationAccount(accountId)) return MIGRATION_ACCOUNT_POLICIES[accountId];
  return 'unreadable';
}

/**
 * Write `legacy` for one migration account when Redis has no row.
 * A stored `legacy` or `protected` row is left as it is. Failure is
 * false and writes nothing else.
 */
export async function persistMigrationAccountPolicy(
  accountId: string,
  input: ProductiveStoreInput,
): Promise<boolean> {
  try {
    if (!isMigrationAccount(accountId)) return false;
    const command = resolveCommand(input);
    if (!input.environment || !command) return false;
    const record = await loadPolicyRecord(accountId, input.environment, command);
    if (!record.ok) return false;
    if (record.present) return true;
    const raw = await evalWithin(
      command,
      ACCOUNT_POLICY_CAS_SCRIPT,
      [redisKey(POLICY_PREFIX, input.environment, accountId)],
      ['0', 'legacy'],
    );
    return raw === 'ok:1';
  } catch {
    return false;
  }
}
