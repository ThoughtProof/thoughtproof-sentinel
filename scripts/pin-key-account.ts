#!/usr/bin/env node
/**
 * Pin one approved API key's account through pinPrincipalKeyAsAdmin.
 *
 * Keys are read only from the process environment (`vercel env run`).
 * Arguments select a fingerprint and an environment. They are not keys.
 * The default is dry-run. Output is fingerprints and status only.
 *
 * This file does not run itself against production.
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     --import ./scripts/register-ts-extension.mjs \
 *     scripts/pin-key-account.ts --environment production
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     --import ./scripts/register-ts-extension.mjs \
 *     scripts/pin-key-account.ts --environment production --key-fp 104867493888
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     --import ./scripts/register-ts-extension.mjs \
 *     scripts/pin-key-account.ts --environment production --key-fp 104867493888 --apply
 *
 * Dry-run and `--apply` both read SENTINEL_PRINCIPAL_PUBLIC_KEY from the
 * environment, not from an argument. Dry-run validates that public key
 * and prints its fingerprint. It does not write. `--apply` pins that
 * key and does not create an account policy. Exit 0 is a dry-run report
 * with a valid signer, or an accepted pin. Exit 2 is a closed failure.
 * Neither exit authorizes a request. Census deterministic:true proves
 * API-key to account mapping only, not signer binding.
 */
import {
  CENSUS_PROVES,
  applyApprovedKeyPin,
  inspectSigningKey,
  publicPinRow,
  selectKeyAccounts,
  type PublicPinRow,
} from '../src/mandate-key-account-pin.ts';
import { isPrincipalEnvironment } from '../src/principal-key-manifest.ts';
import {
  createProductiveManifestStore,
  principalRedisCommand,
} from '../src/principal-manifest-store.ts';

const CLOSED =
  '{"mode":"dry_run","status":"unreadable","authorizes_execution":false,"census_proves":"api_key_account_mapping_only","signer_binding_proven":false}\n';

function fail(): never {
  process.stdout.write(CLOSED);
  process.exit(2);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) fail();
  return value;
}

const KNOWN = new Set(['--apply', '--dry-run', '--key-fp', '--environment']);
const consumed = new Set<number>();
for (const flag of ['--key-fp', '--environment']) {
  const index = process.argv.indexOf(flag);
  if (index !== -1) consumed.add(index + 1);
}
for (let index = 2; index < process.argv.length; index += 1) {
  if (consumed.has(index)) continue;
  const arg = process.argv[index] ?? '';
  if (!KNOWN.has(arg)) fail();
}

const apply = process.argv.includes('--apply');
const dryFlag = process.argv.includes('--dry-run');
if (apply && dryFlag) fail();
const dryRun = !apply;

const keyFpArg = argValue('--key-fp');
const environmentArg = argValue('--environment');

if (keyFpArg !== undefined && !/^[0-9a-f]{12}$/.test(keyFpArg)) fail();
if (environmentArg !== undefined && !isPrincipalEnvironment(environmentArg)) fail();
if (apply && (keyFpArg === undefined || environmentArg === undefined)) fail();

const raw = process.env.SENTINEL_API_KEYS;
if (typeof raw !== 'string') fail();

const selections = selectKeyAccounts(raw);
if (!selections) fail();

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function censusFields(): {
  census_proves: typeof CENSUS_PROVES;
  signer_binding_proven: false;
  authorizes_execution: false;
} {
  return {
    census_proves: CENSUS_PROVES,
    signer_binding_proven: false,
    authorizes_execution: false,
  };
}

function selectedRows(): PublicPinRow[] {
  if (keyFpArg === undefined) return selections.map((selection) => publicPinRow(selection));
  const matches = selections.filter((selection) => selection.key_fp === keyFpArg);
  if (matches.length === 0) {
    return [{ key_fp: keyFpArg, status: 'absent', authorizes_execution: false }];
  }
  return matches.map((selection) => publicPinRow(selection));
}

const nowSeconds = Math.floor(Date.now() / 1000);
const publicKeyRaw = process.env.SENTINEL_PRINCIPAL_PUBLIC_KEY;
let signing: { ok: true; signer_fp: string } | { ok: false; status: string };
if (typeof publicKeyRaw !== 'string' || publicKeyRaw.trim().length === 0) {
  signing = { ok: false, status: 'public_key_missing' };
} else {
  try {
    const inspected = inspectSigningKey(JSON.parse(publicKeyRaw) as unknown, nowSeconds);
    signing = inspected.ok
      ? { ok: true, signer_fp: inspected.signer_fp }
      : { ok: false, status: inspected.status };
  } catch {
    signing = { ok: false, status: 'MALFORMED_REQUEST' };
  }
}

if (!signing.ok) {
  write({
    mode: dryRun ? 'dry_run' : 'apply',
    status: signing.status,
    signer_status: signing.status,
    ...censusFields(),
    ...(dryRun ? { keys: selectedRows() } : { key_fp: keyFpArg }),
  });
  process.exit(2);
}

if (dryRun) {
  write({
    mode: 'dry_run',
    signer_status: 'valid',
    signer_fp: signing.signer_fp,
    ...censusFields(),
    keys: selectedRows(),
  });
  process.exit(0);
}

const keyFp = keyFpArg as string;
const environment = environmentArg as 'production' | 'preview' | 'development';
const chosen = selections.filter((selection) => selection.key_fp === keyFp);
if (chosen.length !== 1 || chosen[0]?.status !== 'approved') {
  const status = chosen.length === 0 ? 'absent' : (chosen[0]?.status ?? 'ambiguous');
  write({
    mode: 'apply',
    key_fp: keyFp,
    status,
    signer_status: 'valid',
    signer_fp: signing.signer_fp,
    ...censusFields(),
  });
  process.exit(2);
}

let publicKey: unknown;
try {
  publicKey = JSON.parse(publicKeyRaw as string) as unknown;
} catch {
  write({
    mode: 'apply',
    key_fp: keyFp,
    status: 'MALFORMED_REQUEST',
    signer_status: 'MALFORMED_REQUEST',
    ...censusFields(),
  });
  process.exit(2);
}

const command = principalRedisCommand(process.env);
if (!command) {
  write({
    mode: 'apply',
    key_fp: keyFp,
    status: 'store_unavailable',
    signer_status: 'valid',
    signer_fp: signing.signer_fp,
    ...censusFields(),
  });
  process.exit(2);
}

const store = createProductiveManifestStore({ environment, env: process.env, command });

let result: { status: string };
try {
  result = await applyApprovedKeyPin({
    raw,
    keyFp,
    environment,
    nowSeconds,
    publicKey,
    store,
  });
} catch {
  write({
    mode: 'apply',
    key_fp: keyFp,
    status: 'store_unavailable',
    signer_status: 'valid',
    signer_fp: signing.signer_fp,
    ...censusFields(),
  });
  process.exit(2);
}

write({
  ...result,
  signer_status: 'valid',
  signer_fp: signing.signer_fp,
  ...censusFields(),
});
process.exit(result.status === 'ACCEPTED' ? 0 : 2);
