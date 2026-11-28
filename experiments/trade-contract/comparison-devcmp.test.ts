import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { replayDirectory, type ReplayStep } from './comparison-replay.ts';

const ARCHIVE = new URL('./fixtures/diag-20261127/raw/', import.meta.url);
const FRESH = new URL('./fixtures/devcmp-20261127/', import.meta.url);
const TICKS = 10_000_000_000;

function kind(step: ReplayStep): string {
  if (step.checkId === 'decision_basis' && step.code === 'REQUIREMENT_SET_MISMATCH') return 'db_mismatch';
  if (step.checkId === 'order_strategy_consistency' && step.code === 'model_status' && step.triggerValue === 'not_applicable') return 'strategy_na';
  if (step.checkId === 'mandate_compliance' && step.code === 'INVALID_SEMANTIC_EVIDENCE') return 'mandate_evidence';
  return 'other';
}

function counts(dir: string) {
  const rows = replayDirectory(dir);
  const every = { db_mismatch: 0, strategy_na: 0, mandate_evidence: 0 };
  const first = { db_mismatch: 0, strategy_na: 0, mandate_evidence: 0, other: [] as string[] };
  const named = (value: string): value is keyof typeof every => value === 'db_mismatch' || value === 'strategy_na' || value === 'mandate_evidence';
  for (const row of rows) {
    for (const step of [row, ...row.followOns]) {
      const name = kind(step);
      if (named(name)) every[name] += 1;
    }
    const head = kind(row);
    if (named(head)) first[head] += 1;
    else first.other.push(`${row.caseId} ${row.arm} ${row.checkId} ${row.code} ${row.rule} ${JSON.stringify(row.triggerValue)}`);
  }
  return { rows, every, first };
}

describe('paid dev comparison at a585f5eb', () => {
  const archive = counts(ARCHIVE.pathname);
  const fresh = counts(join(FRESH.pathname, 'raw'));
  const report = JSON.parse(readFileSync(join(FRESH.pathname, 'report.json'), 'utf8')) as {
    report: { calls_sent: number; cumulativeCostUsd: number; providerOrSchemaErrors: number; rows: { caseId: string; arm: string; parserResult: string; frozenGateVerdict: string; publicVerdict: string }[] };
    timings: { ms: number; status: number }[];
    order: { caseId: string; arm: string }[];
  };

  it('replays both directories on the same gate and matches the Mac verdicts', () => {
    expect(archive.rows.map(row => row.publicVerdict)).toEqual(Array(12).fill('UNCERTAIN'));
    expect(fresh.rows.map(row => `${row.caseId} ${row.arm} ${row.expected} ${row.publicVerdict} ${row.frozenGateVerdict}`)).toEqual([
      'dev-01 A ALLOW UNCERTAIN UNCERTAIN',
      'dev-01 B ALLOW UNCERTAIN UNCERTAIN',
      'dev-02 A BLOCK BLOCK BLOCK',
      'dev-02 B BLOCK BLOCK BLOCK',
      'dev-03 A ALLOW UNCERTAIN UNCERTAIN',
      'dev-03 B ALLOW UNCERTAIN UNCERTAIN',
      'dev-04 A UNCERTAIN UNCERTAIN UNCERTAIN',
      'dev-04 B UNCERTAIN UNCERTAIN UNCERTAIN',
      'dev-05 A BLOCK BLOCK BLOCK',
      'dev-05 B BLOCK BLOCK BLOCK',
      'dev-06 A ALLOW UNCERTAIN UNCERTAIN',
      'dev-06 B ALLOW UNCERTAIN UNCERTAIN',
    ]);
    expect(fresh.rows.every(row => row.parserResult === 'ok')).toBe(true);
    expect(fresh.rows.some(row => row.publicVerdict === 'ALLOW')).toBe(false);
    for (let i = 0; i < fresh.rows.length; i += 2) {
      expect(fresh.rows[i].publicVerdict).toBe(fresh.rows[i + 1].publicVerdict);
    }
    expect(report.report.rows.map(row => `${row.caseId} ${row.arm} ${row.publicVerdict} ${row.frozenGateVerdict}`))
      .toEqual(fresh.rows.map(row => `${row.caseId} ${row.arm} ${row.publicVerdict} ${row.frozenGateVerdict}`));
  });

  it('counts the three contract-form errors on the archive and on the new answers', () => {
    expect(archive.every).toEqual({ db_mismatch: 9, strategy_na: 9, mandate_evidence: 8 });
    expect(archive.first).toMatchObject({ db_mismatch: 9, strategy_na: 3, mandate_evidence: 0, other: [] });
    expect(fresh.every).toEqual({ db_mismatch: 0, strategy_na: 1, mandate_evidence: 0 });
    expect(fresh.first.db_mismatch).toBe(0);
    expect(fresh.first.strategy_na).toBe(1);
    expect(fresh.first.mandate_evidence).toBe(0);
    expect(fresh.first.other).toEqual([
      'dev-01 A order_strategy_consistency model_status evaluate.ts:277 "not_verifiable"',
      'dev-02 A order_strategy_consistency model_status evaluate.ts:277 "not_verifiable"',
      'dev-02 B order_strategy_consistency model_status evaluate.ts:277 "not_verifiable"',
      'dev-03 A order_strategy_consistency model_status evaluate.ts:277 "not_verifiable"',
      'dev-03 B order_strategy_consistency model_status evaluate.ts:277 "not_verifiable"',
      'dev-04 A decision_basis model_status evaluate.ts:277 "not_verifiable"',
      'dev-04 B decision_basis model_status evaluate.ts:277 "not_verifiable"',
      'dev-05 A order_strategy_consistency model_status evaluate.ts:277 "not_verifiable"',
      'dev-05 B order_strategy_consistency model_status evaluate.ts:277 "not_verifiable"',
      'dev-06 A decision_basis model_status evaluate.ts:277 "not_verifiable"',
      'dev-06 B order_strategy_consistency model_status evaluate.ts:277 "not_verifiable"',
    ]);
  });

  it('blocks dev-02 and dev-05 on the contradicted mandate quote', () => {
    const wanted = ['dev-02-A', 'dev-02-B', 'dev-05-A', 'dev-05-B'];
    for (const name of wanted) {
      const saved = JSON.parse(readFileSync(join(FRESH.pathname, 'raw', `${name}.json`), 'utf8')) as { content: string };
      const model = JSON.parse(saved.content) as { semanticChecks: { checkId: string; status: string; quotes: { quote: string }[] }[] };
      const mandate = model.semanticChecks.find(check => check.checkId === 'mandate_compliance');
      expect(mandate?.status).toBe('contradicted');
      const quotes = mandate?.quotes.map(quote => quote.quote) ?? [];
      if (name.startsWith('dev-02')) expect(quotes).toContain('The board minute is not on file.');
      else expect(quotes).toContain('Second approval for INV-440 is still pending.');
    }
  });

  it('books measured ticks only and flags calls over 45 seconds', () => {
    expect(report.report.calls_sent).toBe(12);
    expect(report.report.providerOrSchemaErrors).toBe(0);
    expect(report.timings.map(item => item.status)).toEqual(Array(12).fill(200));
    expect(report.timings.map(item => item.ms)).toEqual([69261, 40272, 45186, 52378, 49904, 50202, 26950, 39022, 42464, 37325, 45719, 34787]);
    const names = readdirSync(join(FRESH.pathname, 'raw')).filter(name => name.endsWith('.json') && !name.startsWith('.'));
    let ticks = 0;
    for (const name of names) {
      const saved = JSON.parse(readFileSync(join(FRESH.pathname, 'raw', name), 'utf8')) as { usage: { cost_in_usd_ticks: number } };
      expect(typeof saved.usage.cost_in_usd_ticks).toBe('number');
      ticks += saved.usage.cost_in_usd_ticks;
    }
    expect(ticks / TICKS).toBeCloseTo(0.36289, 5);
    expect(report.order.map((item, index) => report.timings[index].ms > 45_000)).toEqual([
      true, false, true, true, true, true, false, false, false, false, true, false,
    ]);
  });
});
