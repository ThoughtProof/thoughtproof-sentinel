/**
 * ADR-0023 read-only proof that each API key maps to one account.
 * Counts only. This module does not authorize execution and does not
 * write. It does not read the verify handler and it does not set
 * SENTINEL_MANDATE_PROOF_ENFORCE.
 *
 * The record grammar matches parseSentinelApiKeyRecords. A parity test
 * locks the two parsers together. Do not print a parse result.
 * `deterministic: true` proves each API key has one account id. It does
 * not prove a signer key is bound to that account.
 */

import { createHash } from 'node:crypto';

export const CENSUS_REPORT_FIELDS = [
  'deterministic',
  'authorizes_execution',
  'records',
  'distinct_keys',
  'mapped_keys',
  'unmapped_keys',
  'ambiguous_keys',
  'empty_keys',
  'distinct_accounts',
  'overlap_accounts',
  'rotation_overlap_keys',
  'revoked_keys',
  'revoked_absent',
  'revoked_ambiguous',
  'revoked_unmapped',
  'duplicate_rows',
] as const;

export interface KeyAccountCensus {
  /** True only when every existing key has exactly one account id. */
  deterministic: boolean;
  /** This report never authorizes a request. */
  authorizes_execution: false;
  records: number;
  distinct_keys: number;
  mapped_keys: number;
  unmapped_keys: number;
  ambiguous_keys: number;
  empty_keys: number;
  distinct_accounts: number;
  /** Accounts that have two or more distinct, unambiguous keys. */
  overlap_accounts: number;
  /** Keys that share their one account with another key (rotation overlap). */
  rotation_overlap_keys: number;
  /** Revoked keys that are still present in the record set. */
  revoked_keys: number;
  /** Revoked keys that are not in the record set. */
  revoked_absent: number;
  revoked_ambiguous: number;
  revoked_unmapped: number;
  duplicate_rows: number;
}

export type KeyMapping =
  | {
      maps: true;
      revoked: boolean;
      authorizesExecution: false;
    }
  | {
      maps: false;
      code: 'UNREADABLE' | 'MISSING_KEY' | 'UNKNOWN_KEY' | 'UNMAPPED' | 'AMBIGUOUS' | 'EMPTY_KEY';
      revoked: boolean;
      authorizesExecution: false;
    };

interface CensusRecord {
  key: string;
  accountId?: string;
}

interface Bucket {
  accounts: Set<string>;
  rows: number;
  unmapped: number;
}

interface Analysis {
  records: CensusRecord[];
  buckets: Map<string, Bucket>;
  emptyKeys: number;
  revoked: Set<string>;
}

function blankCensus(): KeyAccountCensus {
  return {
    deterministic: false,
    authorizes_execution: false,
    records: 0,
    distinct_keys: 0,
    mapped_keys: 0,
    unmapped_keys: 0,
    ambiguous_keys: 0,
    empty_keys: 0,
    distinct_accounts: 0,
    overlap_accounts: 0,
    rotation_overlap_keys: 0,
    revoked_keys: 0,
    revoked_absent: 0,
    revoked_ambiguous: 0,
    revoked_unmapped: 0,
    duplicate_rows: 0,
  };
}

/**
 * Same split as `parseSentinelApiKeyRecords`. Account id is only the
 * explicit field. Platform and agent id are not account ids.
 */
function parseCensusRecords(raw: string): CensusRecord[] | null {
  try {
    const records: CensusRecord[] = [];
    for (const entry of raw.split(',')) {
      if (!entry) continue;
      const parts = entry.trim().split(':');
      const key = parts[0] ?? '';
      const record: CensusRecord = { key };
      const accountId = parts.length >= 4 ? parts.slice(3).join(':').trim() : '';
      if (accountId) record.accountId = accountId;
      records.push(record);
    }
    return records;
  } catch {
    return null;
  }
}

function analyze(raw: unknown, revokedKeys: readonly string[]): Analysis | null {
  if (typeof raw !== 'string') return null;
  if (!Array.isArray(revokedKeys)) return null;
  const revoked = new Set<string>();
  for (const key of revokedKeys) {
    if (typeof key !== 'string' || key.length === 0) return null;
    revoked.add(key);
  }
  const records = parseCensusRecords(raw);
  if (!records) return null;
  const buckets = new Map<string, Bucket>();
  let emptyKeys = 0;
  for (const record of records) {
    if (record.key.trim().length === 0) {
      emptyKeys += 1;
      continue;
    }
    let bucket = buckets.get(record.key);
    if (!bucket) {
      bucket = { accounts: new Set<string>(), rows: 0, unmapped: 0 };
      buckets.set(record.key, bucket);
    }
    bucket.rows += 1;
    if (record.accountId) bucket.accounts.add(record.accountId);
    else bucket.unmapped += 1;
  }
  return { records, buckets, emptyKeys, revoked };
}

function bucketClass(bucket: Bucket): 'mapped' | 'unmapped' | 'ambiguous' {
  if (bucket.accounts.size > 1) return 'ambiguous';
  if (bucket.accounts.size === 1 && bucket.unmapped === 0) return 'mapped';
  if (bucket.accounts.size === 1 && bucket.unmapped > 0) return 'ambiguous';
  return 'unmapped';
}

/**
 * Aggregate counts for one `SENTINEL_API_KEYS` value.
 * The return value has no key material, no account id, and no agent id.
 * `authorizes_execution` is false. An empty or unreadable input is not
 * a successful migration (`deterministic: false`).
 */
export function censusSentinelApiKeys(
  raw: unknown,
  revokedKeys: readonly string[] = [],
): KeyAccountCensus {
  try {
    const analysis = analyze(raw, revokedKeys);
    if (!analysis) return blankCensus();

    const report = blankCensus();
    report.records = analysis.records.length;
    report.empty_keys = analysis.emptyKeys;
    report.distinct_keys = analysis.buckets.size;

    const accountKeyCounts = new Map<string, number>();
    const seenAccounts = new Set<string>();
    for (const record of analysis.records) {
      if (record.accountId) seenAccounts.add(record.accountId);
    }
    report.distinct_accounts = seenAccounts.size;

    for (const bucket of analysis.buckets.values()) {
      const kind = bucketClass(bucket);
      if (kind === 'mapped') {
        report.mapped_keys += 1;
        const accountId = [...bucket.accounts][0];
        if (accountId) {
          accountKeyCounts.set(accountId, (accountKeyCounts.get(accountId) ?? 0) + 1);
        }
      } else if (kind === 'unmapped') {
        report.unmapped_keys += 1;
      } else {
        report.ambiguous_keys += 1;
      }
      if (bucket.rows > 1) report.duplicate_rows += bucket.rows - 1;
    }

    for (const count of accountKeyCounts.values()) {
      if (count >= 2) {
        report.overlap_accounts += 1;
        report.rotation_overlap_keys += count;
      }
    }

    for (const key of analysis.revoked) {
      const bucket = analysis.buckets.get(key);
      if (!bucket) {
        report.revoked_absent += 1;
        continue;
      }
      report.revoked_keys += 1;
      const kind = bucketClass(bucket);
      if (kind === 'ambiguous') report.revoked_ambiguous += 1;
      if (kind === 'unmapped') report.revoked_unmapped += 1;
    }

    report.deterministic =
      report.records > 0 &&
      report.empty_keys === 0 &&
      report.ambiguous_keys === 0 &&
      report.unmapped_keys === 0 &&
      report.revoked_ambiguous === 0 &&
      report.revoked_unmapped === 0 &&
      report.mapped_keys === report.distinct_keys;
    report.authorizes_execution = false;
    return report;
  } catch {
    return blankCensus();
  }
}

/**
 * One key's mapping. A revoked key may still map to exactly one account.
 * It does not authorize. This function does not return the account id
 * or the key.
 */
export function inspectKeyMapping(
  raw: unknown,
  apiKey: unknown,
  revokedKeys: readonly string[] = [],
): KeyMapping {
  const denied = (
    code: Extract<KeyMapping, { maps: false }>['code'],
    revoked: boolean,
  ): KeyMapping => ({
    maps: false,
    code,
    revoked,
    authorizesExecution: false,
  });
  try {
    if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.trim().length === 0) {
      return denied('MISSING_KEY', false);
    }
    const analysis = analyze(raw, revokedKeys);
    if (!analysis) return denied('UNREADABLE', false);
    const revoked = analysis.revoked.has(apiKey);
    const bucket = analysis.buckets.get(apiKey);
    if (!bucket) {
      if (analysis.emptyKeys > 0 && apiKey.trim().length === 0) return denied('EMPTY_KEY', revoked);
      return denied('UNKNOWN_KEY', revoked);
    }
    const kind = bucketClass(bucket);
    if (kind === 'ambiguous') return denied('AMBIGUOUS', revoked);
    if (kind === 'unmapped') return denied('UNMAPPED', revoked);
    return { maps: true, revoked, authorizesExecution: false };
  } catch {
    return denied('UNREADABLE', false);
  }
}

/**
 * True when every listed key maps to the same single account.
 * Does not return that account id. Revocation does not change the
 * equality check. An empty list is false.
 */
export function keysShareOneAccount(
  raw: unknown,
  apiKeys: readonly string[],
  revokedKeys: readonly string[] = [],
): boolean {
  try {
    if (!Array.isArray(apiKeys) || apiKeys.length === 0) return false;
    const analysis = analyze(raw, revokedKeys);
    if (!analysis) return false;
    let shared: string | null = null;
    for (const apiKey of apiKeys) {
      if (typeof apiKey !== 'string' || apiKey.length === 0) return false;
      const bucket = analysis.buckets.get(apiKey);
      if (!bucket || bucketClass(bucket) !== 'mapped') return false;
      const accountId = [...bucket.accounts][0];
      if (!accountId) return false;
      if (shared === null) shared = accountId;
      else if (shared !== accountId) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Public fingerprint of one API key. Twelve lowercase hex characters:
 * the leading bytes of SHA-256 over the UTF-8 key. Not the key, not an
 * account id, and not authorization.
 */
export function key_fp(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 12);
}

export function isPublicCensusReport(value: unknown): value is KeyAccountCensus {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  const keys = Object.keys(report);
  if (keys.length !== CENSUS_REPORT_FIELDS.length) return false;
  for (const field of CENSUS_REPORT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(report, field)) return false;
  }
  if (report.authorizes_execution !== false) return false;
  if (typeof report.deterministic !== 'boolean') return false;
  for (const field of CENSUS_REPORT_FIELDS) {
    if (field === 'deterministic' || field === 'authorizes_execution') continue;
    const count = report[field];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return false;
  }
  return true;
}
