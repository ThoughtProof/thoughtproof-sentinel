import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADAPTER_ID, decideCascade, parseOutput } from './adapter.ts';
import { prepareModelContent } from './comparison-grounding.ts';
import { orderCaseById } from './dev-v3/cases.ts';

const ROOT = new URL('./fixtures/orddev-v3-20261127/', import.meta.url);
const V2 = new URL('./fixtures/orddev-20261127/report.json', import.meta.url);

function read(name: string): string {
  return readFileSync(new URL(name, ROOT), 'utf8');
}

function gated(content: string) {
  const documents = orderCaseById('v3-05').documents;
  const prepared = prepareModelContent(content, documents, 'primary');
  const parsed = parseOutput(prepared.publicContent);
  const decision = decideCascade(documents, { ok: true, content: prepared.publicContent }, null, {
    trustedAdapterIds: [ADAPTER_ID],
    diagnostics: true,
  });
  return { parsed, decision };
}

describe('archived dev-v3 paid run', () => {
  const report = JSON.parse(read('report.json')) as {
    calls_sent: number;
    cumulativeCostUsd: number;
    timeoutMs: number;
    rows: { caseId: string; arm: string; publicVerdict: string; expected: string; durationMs: number; decisiveReason: string | null; parserResult: string }[];
  };

  it('matches the stored checksums and the measured totals', () => {
    const listed = read('SHA256SUMS').trim().split('\n').filter(line => !line.startsWith('tarball '));
    for (const line of listed) {
      const [sum, name] = line.split(/\s+/);
      const bytes = readFileSync(new URL(name, ROOT));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sum);
    }
    expect(report.calls_sent).toBe(12);
    expect(report.timeoutMs).toBe(90_000);
    expect(report.cumulativeCostUsd).toBeCloseTo(0.373026, 6);
    expect(report.rows.every(row => row.parserResult === 'ok')).toBe(true);
  });

  it('counts 11 of 12 label hits and separates the 45 second budget', () => {
    const hits = report.rows.filter(row => row.publicVerdict === row.expected);
    expect(hits).toHaveLength(11);
    expect(report.rows.filter(row => row.arm === 'A' && row.publicVerdict === row.expected)).toHaveLength(6);
    expect(report.rows.filter(row => row.arm === 'B' && row.publicVerdict === row.expected)).toHaveLength(5);
    const within = report.rows.filter(row => row.durationMs <= 45_000).map(row => `${row.caseId.slice(3)} ${row.arm}`);
    expect(within).toEqual(['01 A', '01 B', '02 B', '04 A', '04 B', '05 A', '05 B', '06 B']);
    const timelyHits = report.rows.filter(row => row.durationMs <= 45_000 && row.publicVerdict === row.expected);
    expect(timelyHits).toHaveLength(7);
    expect(report.rows.find(row => row.caseId === 'v3-05' && row.arm === 'B')?.publicVerdict).toBe('UNCERTAIN');
    const over = report.rows.filter(row => row.durationMs > 45_000).map(row => [row.caseId, row.arm, row.durationMs]);
    expect(over).toEqual([
      ['v3-02', 'A', 47426],
      ['v3-03', 'A', 45301],
      ['v3-03', 'B', 47366],
      ['v3-06', 'A', 51042],
    ]);
  });

  it('shows v3-05 B is ALLOW before the section_heading downgrade and UNCERTAIN after it', () => {
    const saved = JSON.parse(read('raw/v3-05-B.json')) as { content: string };
    const model = JSON.parse(saved.content) as {
      grounding: null;
      requirements: { kind: string; decidedBy: string; sourceHeading: string; quotes: { quote: string }[] }[];
      semanticChecks: { checkId: string; status: string }[];
      claims: { kind: string; status: string; supportingQuotes: { documentId: string; quote: string }[] }[];
    };
    expect(model.semanticChecks.map(check => check.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(model.claims).toEqual([expect.objectContaining({
      kind: 'source_fact', status: 'fulfilled',
      supportingQuotes: [{ documentId: 'holdings', quote: '40 Helio shares' }],
    })]);
    expect(model.grounding).toBeNull();
    const strategy = model.requirements[0];
    expect(strategy.kind).toBe('strategy');
    expect(strategy.decidedBy).toBe('section_heading');
    expect(strategy.sourceHeading).toBe('Strategy');
    expect(strategy.quotes[0].quote).toBe('Reduce Helio exposure.');
    const published = gated(saved.content);
    expect('failure' in published.parsed).toBe(false);
    expect(published.decision.decision).toBe('UNCERTAIN');
    expect(published.decision.checks.map(check => check.status)).toEqual([
      'not_verifiable', 'not_verifiable', 'not_verifiable', 'not_verifiable', 'not_verifiable',
    ]);
    expect(published.decision.diagnostics ?? []).toEqual([]);
    expect(report.rows.find(row => row.caseId === 'v3-05' && row.arm === 'B')?.decisiveReason)
      .toBe('decision_basis not_verifiable');
    strategy.decidedBy = 'clause';
    const flipped = gated(JSON.stringify(model));
    expect(flipped.decision.decision).toBe('ALLOW');
    expect(flipped.decision.checks).toEqual([
      { checkId: 'decision_basis', status: 'fulfilled' },
      { checkId: 'order_strategy_consistency', status: 'fulfilled' },
      { checkId: 'mandate_compliance', status: 'fulfilled' },
      { checkId: 'additional_claims', status: 'fulfilled' },
      { checkId: 'numeric_limits', status: 'not_applicable' },
    ]);
    const gate = readFileSync(new URL('./adapter.ts', import.meta.url), 'utf8');
    expect(gate).toContain("if (parsed.requirements.some(item => item.decidedBy !== 'clause')) downgradeAllow = true;");
  });

  it('finds one fulfilled holdings claim on every v3 row and clause on every other strategy requirement', () => {
    const dirs = [new URL('./raw/', ROOT), new URL('./fixtures/orddev-20261127/raw/', import.meta.url)];
    const decided = new Map<string, number>();
    for (const dir of dirs) {
      for (const name of readdirSync(dir).filter(item => item.endsWith('.json'))) {
        const saved = JSON.parse(readFileSync(join(dir.pathname, name), 'utf8')) as { content: string };
        const model = JSON.parse(saved.content) as {
          requirements: { kind: string; decidedBy: string }[];
          claims?: { kind: string; status: string; supportingQuotes: { documentId: string }[] }[];
        };
        for (const requirement of model.requirements) {
          const key = `${requirement.kind}:${requirement.decidedBy}`;
          decided.set(key, (decided.get(key) ?? 0) + 1);
        }
        if (!name.startsWith('v3-')) continue;
        expect(model.claims).toHaveLength(1);
        expect(model.claims?.[0]).toMatchObject({ kind: 'source_fact', status: 'fulfilled' });
        expect(model.claims?.[0].supportingQuotes[0].documentId).toBe('holdings');
      }
    }
    expect(decided.get('strategy:section_heading')).toBe(1);
    expect(decided.get('strategy:clause')).toBe(19);
    expect(decided.get('mandate:clause')).toBe(24);
    const v2 = JSON.parse(readFileSync(V2, 'utf8')) as { rows: { caseId: string; arm: string; publicVerdict: string }[] };
    const v2By = new Map(v2.rows.map(row => [`${row.caseId} ${row.arm}`, row.publicVerdict]));
    expect(v2By.get('ord-05 A')).toBe('UNCERTAIN');
    expect(report.rows.find(row => row.caseId === 'v3-05' && row.arm === 'A')?.publicVerdict).toBe('ALLOW');
  });
});
