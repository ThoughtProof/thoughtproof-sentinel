/**
 * Operator selection of one API key by `key_fp`, then one pin through
 * `pinPrincipalKeyAsAdmin`. The verify API key is not the grant. This
 * module does not set SENTINEL_MANDATE_PROOF_ENFORCE, does not rewrite
 * SENTINEL_API_KEYS, and does not print key material.
 */

import { parseSentinelApiKeyRecords } from './server-account.js';
import { key_fp } from './mandate-key-account-census.js';
import {
  pinPrincipalKeyAsAdmin,
  type PrincipalAdminAuditEntry,
  type PrincipalAdminPinStore,
} from './principal-key-admin.js';
import {
  persistMigrationAccountPolicy,
  type PrincipalRedisCommand,
  type ProductiveStoreInput,
} from './principal-manifest-store.js';
import type { PrincipalEnvironment } from './principal-key-manifest.js';

/**
 * Raul's choices. `key_fp` is the census fingerprint of the API key.
 * The agent id is a label for the operator, not the account id.
 */
export const APPROVED_KEY_ACCOUNTS = [
  { key_fp: '104867493888', accountId: 'acct_v3api', agent_id: 'v3api' },
  { key_fp: '00f666d19701', accountId: 'acct_grokbot', agent_id: 'grokbot' },
  { key_fp: '74541b14c65c', accountId: 'acct_nightly', agent_id: 'nightly-suite' },
] as const;

export type ApprovedKeyAccount = {
  key_fp: string;
  accountId: string;
  agent_id?: string;
};

const PRIVATE_KEY_FIELDS = new Set([
  'd',
  'k',
  'priv',
  'private',
  'privateKey',
  'private_key',
  'seed',
]);

export type PinSelectionStatus = 'approved' | 'unapproved' | 'ambiguous' | 'empty';

export interface PinSelection {
  key_fp?: string;
  status: PinSelectionStatus;
  accountId?: string;
  authorizesExecution: false;
}

export interface PublicPinRow {
  key_fp?: string;
  status: string;
  authorizes_execution: false;
}

export interface PublicApplyResult {
  mode: 'apply';
  key_fp: string;
  status: string;
  authorizes_execution: false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function approvedAccount(table: readonly ApprovedKeyAccount[], fp: string): string | undefined {
  const row = table.find((entry) => entry.key_fp === fp);
  return row?.accountId;
}

/**
 * One row per distinct key. Account ids stay on the selection for the
 * writer. `publicPinRow` drops them.
 */
export function selectKeyAccounts(
  raw: unknown,
  table: readonly ApprovedKeyAccount[] = APPROVED_KEY_ACCOUNTS,
): PinSelection[] | null {
  try {
    const records = parseSentinelApiKeyRecords(raw);
    if (!records) return null;
    const empties: PinSelection[] = [];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const record of records) {
      if (typeof record.key !== 'string' || record.key.trim().length === 0) {
        empties.push({ status: 'empty', authorizesExecution: false });
        continue;
      }
      if (seen.has(record.key)) continue;
      seen.add(record.key);
      keys.push(record.key);
    }
    const fingerprints = keys.map((apiKey) => key_fp(apiKey));
    const counts = new Map<string, number>();
    for (const fp of fingerprints) counts.set(fp, (counts.get(fp) ?? 0) + 1);
    const selections: PinSelection[] = fingerprints.map((fp) => {
      const accountId = approvedAccount(table, fp);
      if ((counts.get(fp) ?? 0) > 1) {
        return { key_fp: fp, status: 'ambiguous', authorizesExecution: false };
      }
      if (!accountId) return { key_fp: fp, status: 'unapproved', authorizesExecution: false };
      return { key_fp: fp, status: 'approved', accountId, authorizesExecution: false };
    });
    return [...selections, ...empties];
  } catch {
    return null;
  }
}

export function publicPinRow(selection: PinSelection): PublicPinRow {
  const row: PublicPinRow = {
    status: selection.status,
    authorizes_execution: false,
  };
  if (selection.key_fp) row.key_fp = selection.key_fp;
  return row;
}

function stringFields(value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  const found: string[] = [];
  for (const field of Object.values(value)) {
    if (typeof field === 'string' && field.length >= 8) found.push(field);
  }
  return found;
}

function auditIsClean(entry: PrincipalAdminAuditEntry, secrets: readonly string[]): boolean {
  const json = JSON.stringify(entry);
  return secrets.every((secret) => secret.length < 8 || !json.includes(secret));
}

function applyResult(keyFp: string, status: string): PublicApplyResult {
  return {
    mode: 'apply',
    key_fp: keyFp,
    status,
    authorizes_execution: false,
  };
}

export interface ApplyKeyPinInput {
  raw: unknown;
  keyFp: string;
  environment: PrincipalEnvironment;
  nowSeconds: number;
  publicKey: unknown;
  store: PrincipalAdminPinStore;
  table?: readonly ApprovedKeyAccount[];
  /** Required when policy persistence is on. */
  storeInput?: ProductiveStoreInput;
  command?: PrincipalRedisCommand | null;
  /** Default true. False skips the policy write. */
  persistPolicy?: boolean;
}

/**
 * Pin the approved public key for one fingerprint. Dry-run does not call
 * this. A result is fingerprints and status only.
 */
export async function applyApprovedKeyPin(input: ApplyKeyPinInput): Promise<PublicApplyResult> {
  const table = input.table ?? APPROVED_KEY_ACCOUNTS;
  const selections = selectKeyAccounts(input.raw, table);
  if (!selections) return applyResult(input.keyFp, 'unreadable');
  const matches = selections.filter((selection) => selection.key_fp === input.keyFp);
  if (matches.length !== 1) return applyResult(input.keyFp, 'absent');
  const match = matches[0];
  if (!match || match.status !== 'approved' || !match.accountId) {
    return applyResult(input.keyFp, match?.status ?? 'absent');
  }
  const accountId = match.accountId;

  if (!isPlainObject(input.publicKey)) return applyResult(input.keyFp, 'malformed_request');
  if (Object.keys(input.publicKey).some((name) => PRIVATE_KEY_FIELDS.has(name))) {
    return applyResult(input.keyFp, 'private_key_present');
  }

  const secrets = [...stringFields(input.publicKey), accountId];
  const persist = input.persistPolicy !== false;
  if (persist) {
    const storeInput: ProductiveStoreInput = input.storeInput ?? {
      environment: input.environment,
      command: input.command ?? null,
    };
    let wrote = false;
    try {
      wrote = await persistMigrationAccountPolicy(accountId, storeInput);
    } catch {
      wrote = false;
    }
    if (!wrote) return applyResult(input.keyFp, 'policy_unwritten');
  }

  let loaded: unknown;
  try {
    loaded = await input.store.load(accountId);
  } catch {
    return applyResult(input.keyFp, 'store_unavailable');
  }
  if (
    !isPlainObject(loaded) ||
    loaded.answered !== true ||
    typeof loaded.version !== 'string' ||
    loaded.version.length === 0
  ) {
    return applyResult(input.keyFp, 'store_unavailable');
  }

  try {
    const result = await pinPrincipalKeyAsAdmin({
      grant: {
        role: 'account_holder',
        accountId,
        actions: ['pin', 'rotate_add'],
      },
      accountId,
      environment: input.environment,
      expectedVersion: loaded.version,
      nowSeconds: input.nowSeconds,
      key: input.publicKey,
      store: input.store,
      audit(entry: PrincipalAdminAuditEntry) {
        if (!auditIsClean(entry, secrets)) throw new Error('audit_leaked');
      },
    });
    return applyResult(input.keyFp, result.code);
  } catch {
    return applyResult(input.keyFp, 'store_unavailable');
  }
}
