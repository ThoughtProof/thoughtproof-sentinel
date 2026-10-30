/**
 * Fail unless every named mandate-replay case is present and passed.
 * Aggregate Vitest counts are printed and ignored. A green total with a
 * missing, skipped, todo, pending, disabled, or failed expected case
 * exits 1.
 *
 * Usage: node scripts/verify-mandate-replay-report.mjs <vitest-json>
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('usage: node scripts/verify-mandate-replay-report.mjs <vitest-json>');
  process.exit(1);
}

const expectedPath = join(dirname(fileURLToPath(import.meta.url)), 'mandate-replay-ci-expected.json');
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
const redisNames = expected.redis;
const deadlineNames = expected.deadline;

if (!Array.isArray(redisNames) || redisNames.length !== 16) {
  console.error(`expected list must name exactly 16 Redis cases, found ${redisNames?.length ?? 0}`);
  process.exit(1);
}
if (!Array.isArray(deadlineNames) || deadlineNames.length !== 3) {
  console.error(`expected list must name exactly 3 deadline cases, found ${deadlineNames?.length ?? 0}`);
  process.exit(1);
}

const groups = [
  { label: 'redis', fileSuffix: expected.redisFile, names: redisNames },
  { label: 'deadline', fileSuffix: expected.deadlineFile, names: deadlineNames },
];

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const seen = new Map();
for (const file of report.testResults ?? []) {
  const fileName = typeof file.name === 'string' ? file.name : '';
  for (const assertion of file.assertionResults ?? []) {
    const title = assertion.title;
    if (typeof title !== 'string' || title.length === 0) continue;
    const hits = seen.get(title) ?? [];
    hits.push({ status: assertion.status, fileName });
    seen.set(title, hits);
  }
}

console.log(
  `ignored aggregate success=${String(report.success)} numPassedTests=${String(report.numPassedTests)} numTotalTests=${String(report.numTotalTests)}`,
);

let failed = false;
const rows = [];
for (const group of groups) {
  for (const name of group.names) {
    const hits = seen.get(name) ?? [];
    const inFile = hits.filter((hit) => hit.fileName.endsWith(group.fileSuffix));
    let status = 'missing';
    if (hits.length > 1 || inFile.length > 1) status = 'duplicate';
    else if (inFile.length === 1) status = String(inFile[0].status);
    else if (hits.length === 1) status = 'wrong-file';
    const ok = status === 'passed';
    if (!ok) failed = true;
    rows.push({ group: group.label, name, status });
    console.log(`${ok ? 'ok' : 'FAIL'} status=${status} [${group.label}] ${name}`);
  }
}

console.log(JSON.stringify({ ok: !failed, cases: rows }, null, 2));
if (failed) process.exit(1);
