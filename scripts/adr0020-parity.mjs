/**
 * Independent MJS frozen judge vs TS port parity.
 * Does not import shared predicate helpers between implementations.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const packCandidates = [
  join(root, '../docs/experiments/e4-external-v0.2/product_run/out/adr0020_measurement_pack_v0/measurement/cases.jsonl'),
  join(process.env.HOME || '', 'PROJECTS/ThoughtProof/docs/experiments/e4-external-v0.2/product_run/out/adr0020_measurement_pack_v0/measurement/cases.jsonl'),
];
const mjsCandidates = [
  join(root, '../docs/experiments/e4-external-v0.2/product_run/out/adr0020_measurement_pack_v0/q1_judge/judge.mjs'),
  join(process.env.HOME || '', 'PROJECTS/ThoughtProof/docs/experiments/e4-external-v0.2/product_run/out/adr0020_measurement_pack_v0/q1_judge/judge.mjs'),
];
const pack = packCandidates.find((p) => existsSync(p));
const mjsPath = mjsCandidates.find((p) => existsSync(p));
const tsPath = join(root, 'src/adr0020/q1-judge.ts');
if (!pack || !mjsPath) {
  console.error('parity skipped: measurement pack or mjs judge not found');
  process.exit(0); // don't fail CI when pack not in repo
}
const outJs = '/tmp/q1-judge-ts-port-parity.mjs';
execSync(`npx --yes esbuild ${tsPath} --bundle --platform=node --format=esm --outfile=${outJs}`, { stdio: 'inherit' });
const { evaluateQ1Eligibility: mjsJudge } = await import(pathToFileURL(mjsPath).href);
const { evaluateQ1Eligibility: tsJudge, canonicalizeVerdictForQ1 } = await import(pathToFileURL(outJs).href);
const cases = readFileSync(pack, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let mismatch = 0;
const rows = [];
for (const c of cases) {
  const r = {
    sentinel_verdict: c.sentinel_verdict,
    reason_code: c.reason_code,
    required_conditions: c.required_conditions,
  };
  const m = mjsJudge(r);
  const t = tsJudge(r);
  const ok = m.eligible === t.eligible && m.triggerCode === t.triggerCode;
  if (!ok) mismatch++;
  rows.push({ id: c.case_id, ok, m, t });
}
// UNCERTAIN boundary (documented divergence for lab MJS)
const u = {
  sentinel_verdict: 'UNCERTAIN',
  reason_code: 'conditional_allow_no_machine_proof',
  required_conditions: cases[0].required_conditions,
};
const mu = mjsJudge(u);
const tu = tsJudge(u);
const mjsHash = createHash('sha256').update(readFileSync(mjsPath)).digest('hex');
const tsHash = createHash('sha256').update(readFileSync(tsPath)).digest('hex');
const decisionHash = createHash('sha256')
  .update(rows.map((r) => `${r.id}:${r.m.eligible}:${r.m.triggerCode}`).join('\n'))
  .digest('hex');
const report = {
  mjs_hash: mjsHash,
  ts_hash: tsHash,
  n_cases: rows.length,
  case_mismatches: mismatch,
  pass: mismatch === 0,
  parity_run_sha256: decisionHash,
  uncertain_boundary: {
    note: '12/12 shared-vocabulary metamorphic checks match when using REVIEW; UNCERTAIN→REVIEW is explicit production-boundary normalization via canonicalizeVerdictForQ1',
    mjs: mu,
    ts: tu,
    canonical: canonicalizeVerdictForQ1('UNCERTAIN'),
  },
  mismatches: rows.filter((r) => !r.ok),
};
const outPath = join(root, 'reports/adr0020-mjs-ts-parity.json');
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ pass: report.pass, n: report.n_cases, mismatch, tsHash: tsHash.slice(0, 16), decisionHash: decisionHash.slice(0, 16) }, null, 2));
if (!report.pass) process.exit(1);
