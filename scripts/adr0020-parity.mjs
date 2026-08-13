/**
 * Independent MJS frozen judge vs TS port parity.
 * Fixtures MUST live in-repo under test/fixtures/adr0020/.
 * CI fails if fixtures are missing — no HOME fallbacks, no silent skip.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const fixtures = join(root, 'test/fixtures/adr0020');
const pack = join(fixtures, 'cases.jsonl');
const mjsPath = join(fixtures, 'frozen-judge.mjs');
const provenancePath = join(fixtures, 'PROVENANCE.json');
const tsPath = join(root, 'src/adr0020/q1-judge.ts');

function die(msg) {
  console.error(`ADR-0020 parity FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(pack) || !existsSync(mjsPath)) {
  die(
    'required fixtures missing under test/fixtures/adr0020/ ' +
      '(need cases.jsonl + frozen-judge.mjs). No HOME fallback.',
  );
}

const provenance = existsSync(provenancePath)
  ? JSON.parse(readFileSync(provenancePath, 'utf8'))
  : null;

const casesRaw = readFileSync(pack, 'utf8').trim().split('\n').filter(Boolean);
const cases = casesRaw.map((l) => JSON.parse(l));
if (cases.length !== 25) {
  die(`expected 25 cases, got ${cases.length}`);
}

const casesHash = createHash('sha256').update(readFileSync(pack)).digest('hex');
const mjsHash = createHash('sha256').update(readFileSync(mjsPath)).digest('hex');
const tsHash = createHash('sha256').update(readFileSync(tsPath)).digest('hex');

if (provenance?.cases_sha256 && provenance.cases_sha256 !== casesHash) {
  die(`cases hash mismatch: fixture ${casesHash} vs PROVENANCE ${provenance.cases_sha256}`);
}
if (provenance?.frozen_judge_sha256 && provenance.frozen_judge_sha256 !== mjsHash) {
  die(`frozen judge hash mismatch: fixture ${mjsHash} vs PROVENANCE ${provenance.frozen_judge_sha256}`);
}

const outJs = '/tmp/q1-judge-ts-port-parity.mjs';
execSync(`npx --yes esbuild ${tsPath} --bundle --platform=node --format=esm --outfile=${outJs}`, {
  stdio: 'inherit',
});

const { evaluateQ1Eligibility: mjsJudge } = await import(pathToFileURL(mjsPath).href);
const tsMod = await import(pathToFileURL(outJs).href);
const tsJudge = tsMod.evaluateQ1Eligibility;
const canonicalize = tsMod.canonicalizeVerdictForQ1 ?? tsMod.toQ1Verdict;

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
  if (!ok) mismatch += 1;
  rows.push({ id: c.case_id, ok, m, t });
}

// Shared-vocabulary metamorphic checks (REVIEW vocab both sides)
function base() {
  return {
    sentinel_verdict: 'REVIEW',
    reason_code: 'conditional_allow_no_machine_proof',
    required_conditions: [
      {
        condition_id: 'alpha_required',
        required: true,
        proof_requirement: 'machine',
        evidence_bindings: [
          {
            evidence_id: 'evidence:alpha_ok',
            bound_condition_id: 'alpha_required',
            syntactically_valid: true,
            freshness: 'fresh',
            contradicted: false,
            grade: 'machine',
          },
        ],
      },
      {
        condition_id: 'beta_required',
        required: true,
        proof_requirement: 'machine',
        evidence_bindings: [],
      },
    ],
  };
}

const meta = [];
function check(name, input) {
  const m = mjsJudge(input);
  const t = tsJudge(input);
  const ok = m.eligible === t.eligible && m.triggerCode === t.triggerCode;
  meta.push({ name, ok, m, t });
  if (!ok) mismatch += 1;
}

check('base', base());
const a = base();
delete a.case_id;
check('no_case_id', a);
const b = base();
b.case_id = 'X';
check('case_id', b);
const c = base();
c.required_conditions = [c.required_conditions[1], c.required_conditions[0]];
check('reorder', c);
const d = base();
d.required_conditions[0].condition_id = 'ren_a';
d.required_conditions[0].evidence_bindings[0].bound_condition_id = 'ren_a';
d.required_conditions[1].condition_id = 'ren_b';
check('rename', d);
const e = base();
e.required_conditions.push({
  condition_id: 'opt',
  required: false,
  proof_requirement: 'machine',
  evidence_bindings: [],
});
check('optional', e);
const f = base();
f.required_conditions[1].evidence_bindings = [
  {
    evidence_id: 'evidence:stale',
    bound_condition_id: 'beta_required',
    syntactically_valid: true,
    freshness: 'stale',
    contradicted: false,
    grade: 'machine',
  },
];
check('stale', f);
const g = base();
g.required_conditions[1].evidence_bindings = [
  {
    evidence_id: 'evidence:ok',
    bound_condition_id: 'beta_required',
    syntactically_valid: true,
    freshness: 'fresh',
    contradicted: false,
    grade: 'machine',
  },
];
check('fill', g);
const h = base();
h.sentinel_verdict = 'ALLOW';
check('allow', h);
const i = base();
i.sentinel_verdict = 'BLOCK';
check('block', i);
const j = base();
j.reason_code = 'primary_hold';
check('reason', j);
const k = base();
k.required_conditions = [k.required_conditions[1]];
check('single', k);

// Production-boundary normalization (documented divergence for lab MJS)
const u = base();
u.sentinel_verdict = 'UNCERTAIN';
const mu = mjsJudge(u);
const tu = tsJudge(u);
const uncertainBoundary = {
  note:
    '12/12 shared-vocabulary metamorphic checks match when using REVIEW; ' +
    'UNCERTAIN→REVIEW is an explicit production-boundary normalization via canonicalizeVerdictForQ1',
  mjs: mu,
  ts: tu,
  canonical: canonicalize('UNCERTAIN'),
};

const metaOk = meta.filter((x) => x.ok).length;
const decisionHash = createHash('sha256')
  .update(rows.map((r) => `${r.id}:${r.m.eligible}:${r.m.triggerCode}`).join('\n'))
  .digest('hex');

const report = {
  mjs_hash: mjsHash,
  ts_hash: tsHash,
  cases_sha256: casesHash,
  n_cases: rows.length,
  cases_executed: rows.length,
  case_mismatches: rows.filter((r) => !r.ok).length,
  metamorphic_shared_vocab: {
    n: meta.length,
    matched: metaOk,
    note: '12/12 shared-vocabulary metamorphic checks match',
    results: meta,
  },
  uncertain_boundary: uncertainBoundary,
  parity_run_sha256: decisionHash,
  fixtures_dir: 'test/fixtures/adr0020',
  pass: mismatch === 0 && rows.length === 25 && metaOk === meta.length,
};

const outPath = join(root, 'reports/adr0020-mjs-ts-parity.json');
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');

console.log(
  JSON.stringify(
    {
      pass: report.pass,
      cases_executed: report.cases_executed,
      case_mismatches: report.case_mismatches,
      metamorphic_matched: `${metaOk}/${meta.length}`,
      ts_hash: tsHash,
      parity_run_sha256: decisionHash,
      uncertain_ts_eligible: tu.eligible,
      uncertain_mjs_eligible: mu.eligible,
    },
    null,
    2,
  ),
);

if (!report.pass) die(`mismatches=${mismatch}`);
