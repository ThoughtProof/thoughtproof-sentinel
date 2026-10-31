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
 * `--apply` also reads SENTINEL_PRINCIPAL_PUBLIC_KEY (a public-key JSON
 * object). Dry-run does not read that variable. Exit 0 is a dry-run
 * report, or an accepted pin. Exit 2 is a closed failure. Neither exit
 * authorizes a request.
 */
import {
  applyApprovedKeyPin,
  publicPinRow,
  selectKeyAccounts,
  type PublicPinRow,
} from '../src/mandate-key-account-pin.ts';
import { isPrincipalEnvironment } from '../src/principal-key-manifest.ts';
import {
  createProductiveManifestStore,
  principalRedisCommand,
} from '../src/principal-manifest-store.ts';

const CLOSED = '{"mode":"dry_run","status":"unreadable","authorizes_execution":false}\n';

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

if (dryRun) {
  let keys: PublicPinRow[];
  if (keyFpArg === undefined) {
    keys = selections.map((selection) => publicPinRow(selection));
  } else {
    const matches = selections.filter((selection) => selection.key_fp === keyFpArg);
    keys = matches.length === 0
      ? [{ key_fp: keyFpArg, status: 'absent', authorizes_execution: false }]
      : matches.map((selection) => publicPinRow(selection));
  }
  write({ mode: 'dry_run', authorizes_execution: false, keys });
  process.exit(0);
}

const keyFp = keyFpArg as string;
const environment = environmentArg as 'production' | 'preview' | 'development';
const chosen = selections.filter((selection) => selection.key_fp === keyFp);
if (chosen.length !== 1 || chosen[0]?.status !== 'approved') {
  const status = chosen.length === 0 ? 'absent' : (chosen[0]?.status ?? 'ambiguous');
  write({ mode: 'apply', key_fp: keyFp, status, authorizes_execution: false });
  process.exit(2);
}

const publicKeyRaw = process.env.SENTINEL_PRINCIPAL_PUBLIC_KEY;
if (typeof publicKeyRaw !== 'string' || publicKeyRaw.trim().length === 0) {
  write({ mode: 'apply', key_fp: keyFp, status: 'public_key_missing', authorizes_execution: false });
  process.exit(2);
}

let publicKey: unknown;
try {
  publicKey = JSON.parse(publicKeyRaw) as unknown;
} catch {
  write({ mode: 'apply', key_fp: keyFp, status: 'malformed_request', authorizes_execution: false });
  process.exit(2);
}

const command = principalRedisCommand(process.env);
if (!command) {
  write({ mode: 'apply', key_fp: keyFp, status: 'store_unavailable', authorizes_execution: false });
  process.exit(2);
}

const storeInput = { environment, env: process.env, command };
const store = createProductiveManifestStore(storeInput);

let result: { status: string };
try {
  result = await applyApprovedKeyPin({
    raw,
    keyFp,
    environment,
    nowSeconds: Math.floor(Date.now() / 1000),
    publicKey,
    store,
    storeInput,
    command,
    persistPolicy: true,
  });
} catch {
  write({ mode: 'apply', key_fp: keyFp, status: 'store_unavailable', authorizes_execution: false });
  process.exit(2);
}

write(result);
process.exit(result.status === 'ACCEPTED' ? 0 : 2);
