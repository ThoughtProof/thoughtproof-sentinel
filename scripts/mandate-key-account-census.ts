#!/usr/bin/env node
/**
 * Read-only aggregate counts for SENTINEL_API_KEYS.
 *
 * Prints a fixed JSON object of counts. It does not print key material,
 * account ids, agent ids, or the raw record string.
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     scripts/mandate-key-account-census.ts --file ./local-keys.txt
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     scripts/mandate-key-account-census.ts --file ./local-keys.txt --revoked ./local-revoked.txt
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     scripts/mandate-key-account-census.ts --from-env
 *
 * --from-env is for a later operator run in a process that already has
 * the variable. This repository does not run it against production.
 * Exit 0 means a count report was produced. It does not mean the mapping
 * is deterministic. Exit 2 means the input could not be read. The error
 * text is fixed and does not include the input.
 */
import { readFileSync } from 'node:fs';
import {
  censusSentinelApiKeys,
  isPublicCensusReport,
} from '../src/mandate-key-account-census.ts';

const FAIL_REPORT =
  '{"deterministic":false,"authorizes_execution":false,"error":"unreadable"}\n';

function fail(): never {
  process.stdout.write(FAIL_REPORT);
  process.exit(2);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) fail();
  return value;
}

const fromEnv = process.argv.includes('--from-env');
const file = argValue('--file');
const revokedFile = argValue('--revoked');

if (fromEnv === Boolean(file)) fail();
if (!fromEnv && !file) fail();

let raw: string;
try {
  if (fromEnv) {
    if (typeof process.env.SENTINEL_API_KEYS !== 'string') fail();
    raw = process.env.SENTINEL_API_KEYS;
  } else {
    raw = readFileSync(file as string, 'utf8');
  }
} catch {
  fail();
}

let revoked: string[] = [];
if (revokedFile) {
  try {
    revoked = readFileSync(revokedFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    fail();
  }
}

let report: unknown;
try {
  report = censusSentinelApiKeys(raw, revoked);
} catch {
  fail();
}

if (!isPublicCensusReport(report)) fail();
process.stdout.write(`${JSON.stringify(report)}\n`);
