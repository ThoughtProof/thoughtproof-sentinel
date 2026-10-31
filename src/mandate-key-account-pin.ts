/**
 * Operator selection of one API key by `key_fp`, then one pin through
 * `pinPrincipalKeyAsAdmin`. The verify API key is not the grant. This
 * module does not set SENTINEL_MANDATE_PROOF_ENFORCE, does not rewrite
 * SENTINEL_API_KEYS, and does not print key material.
 */

import { parseSentinelApiKeyRecords } from './server-account.js';
import { key_fp } from './mandate-key-account-census.js';
import {
  classifySubmittedPrincipalKey,
  pinPrincipalKeyAsAdmin,
  type PrincipalAdminAuditEntry,
  type PrincipalAdminPinStore,
} from './principal-key-admin.js';
import type { PrincipalEnvironment } from './principal-key-manifest.js';

/**
 * What a deterministic census proves. It does not prove that a signer
 * key is bound to the account.
 */
export const CENSUS_PROVES = 'api_key_account_mapping_only' as const;

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

export type SigningKeyInspection =
  | { ok: true; signer_fp: string; authorizesExecution: false }
  | { ok: false; status: 'PRIVATE_KEY_PRESENT' | 'ROTATED_KEY' | 'MALFORMED_REQUEST' | 'WINDOW_INVALID'; authorizesExecution: false };

/**
 * Validate one submitted public key and return only its fingerprint.
 * The fingerprint is `key_fp` of `x`. It is not the API-key census
 * fingerprint and it does not prove the key is stored for an account.
 */
export function inspectSigningKey(value: unknown, nowSeconds: number): SigningKeyInspection {
  try {
    const parsed = classifySubmittedPrincipalKey(value, nowSeconds);
    if (!parsed.ok) return { ok: false, status: parsed.code, authorizesExecution: false };
    return { ok: true, signer_fp: key_fp(parsed.key.x), authorizesExecution: false };
  } catch {
    return { ok: false, status: 'MALFORMED_REQUEST', authorizesExecution: false };
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
}

/**
 * Pin the approved public key for one fingerprint. Does not create an
 * account policy row. Dry-run does not call this. A result is
 * fingerprints and status only.
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

  const signing = inspectSigningKey(input.publicKey, input.nowSeconds);
  if (!signing.ok) return applyResult(input.keyFp, signing.status);

  const secrets = [...stringFields(input.publicKey), accountId];

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
