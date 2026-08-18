#!/usr/bin/env node
/** F5 acceptance smoke — run: node scripts/f5-smoke.mjs */
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dir = dirname(fileURLToPath(import.meta.url));
const fix = join(dir, 'fixtures', 'f5');
const script = join(dir, 'verify-receipt.mjs');
const pub = readFileSync(join(fix, 'pubkey.txt'), 'utf8').trim();

function run(args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: r.status ?? 2, out: (r.stdout || '') + (r.stderr || '') };
}

const cases = [
  {
    name: 'valid+trusted passes',
    args: [join(fix, 'receipt-valid.json'), join(fix, 'request-valid.json'), '--trusted-pubkey', pub],
    expect: 0,
  },
  {
    name: 'forged claims recomputed fails offline',
    args: [join(fix, 'receipt-forged.json'), join(fix, 'request-forged.json'), '--trusted-pubkey', pub],
    expect: 1,
  },
  {
    name: 'evidence without trusted keys fails closed',
    args: [join(fix, 'receipt-valid.json'), join(fix, 'request-valid.json')],
    expect: 1,
  },
  {
    name: 'receipt-only with claimed evidence fails closed',
    args: [join(fix, 'receipt-valid.json')],
    expect: 1,
  },
];

let failed = 0;
for (const c of cases) {
  const r = run(c.args);
  const ok = r.code === c.expect;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name} (exit ${r.code}, expected ${c.expect})`);
  if (!ok) {
    failed++;
    console.log(r.out.slice(0, 400));
  }
}
process.exit(failed === 0 ? 0 : 1);
