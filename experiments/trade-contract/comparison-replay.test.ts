import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADAPTER_ID, decideCascade } from './adapter.ts';
import { caseById } from './comparison-cases.ts';
import { prepareModelContent } from './comparison-grounding.ts';
import { assessModelText } from './comparison-report.ts';
import { replayDirectory } from './comparison-replay.ts';

const RAW = new URL('./fixtures/diag-20261127/raw/', import.meta.url);

function load(caseId: string, arm: 'A' | 'B'): Record<string, unknown> {
  const saved = JSON.parse(readFileSync(join(RAW.pathname, `${caseId}-${arm}.json`), 'utf8')) as { content: string };
  return JSON.parse(saved.content) as Record<string, unknown>;
}

function verdict(caseId: string, model: Record<string, unknown>): string {
  const assessed = assessModelText(caseById(caseId).documents, JSON.stringify(model));
  return `${assessed.frozenGateVerdict}/${assessed.publicVerdict}`;
}

type Check = {
  checkId: string;
  status: string;
  requirementIds: string[];
  quotes: { documentId: string; quote: string }[];
};

function checksOf(model: Record<string, unknown>): Check[] {
  return model.semanticChecks as Check[];
}

function citeMandate(model: Record<string, unknown>, proposal: string, extra: { documentId: string; quote: string }[] = []): void {
  const checks = checksOf(model);
  const mandate = checks.find(check => check.checkId === 'mandate_compliance');
  const requirements = model.requirements as { quotes: { documentId: string; quote: string }[] }[];
  if (!mandate) throw new Error('mandate check missing');
  mandate.quotes = [
    { documentId: 'proposal', quote: proposal },
    ...requirements.flatMap(requirement => requirement.quotes),
    ...extra,
  ];
}

function restoreStrategy(model: Record<string, unknown>, quotes: { documentId: string; quote: string }[]): void {
  const strategy = checksOf(model).find(check => check.checkId === 'order_strategy_consistency');
  if (!strategy) throw new Error('strategy check missing');
  strategy.status = 'fulfilled';
  strategy.requirementIds = [];
  strategy.quotes = quotes;
  const applicability = model.applicability as { checkId: string; status: string; basis: string }[];
  const row = applicability.find(item => item.checkId === 'order_strategy_consistency');
  if (!row) throw new Error('strategy applicability missing');
  row.status = 'applicable';
  row.basis = 'mandatory';
}

describe('recorded diagnostic replay', () => {
  const rows = replayDirectory(RAW.pathname);

  it('replays all 12 saved answers as parser ok and UNCERTAIN at the frozen gate', () => {
    expect(rows).toHaveLength(12);
    expect(rows.map(row => `${row.caseId} ${row.arm} ${row.expected} ${row.parserResult} ${row.frozenGateVerdict} ${row.publicVerdict} ${row.checkId} ${row.rule} ${row.code} ${row.triggerPath}=${JSON.stringify(row.triggerValue)}`)).toEqual([
      'dev-01 A ALLOW ok UNCERTAIN UNCERTAIN decision_basis evaluate.ts:267-269 REQUIREMENT_SET_MISMATCH $.semanticChecks[0].requirementIds=["req-settle"]',
      'dev-01 B ALLOW ok UNCERTAIN UNCERTAIN decision_basis evaluate.ts:267-269 REQUIREMENT_SET_MISMATCH $.semanticChecks[0].requirementIds=["m1"]',
      'dev-02 A BLOCK ok UNCERTAIN UNCERTAIN order_strategy_consistency evaluate.ts:277 model_status $.semanticChecks[1].status="not_applicable"',
      'dev-02 B BLOCK ok UNCERTAIN UNCERTAIN decision_basis evaluate.ts:267-269 REQUIREMENT_SET_MISMATCH $.semanticChecks[0].requirementIds=["req-minute"]',
      'dev-03 A ALLOW ok UNCERTAIN UNCERTAIN decision_basis evaluate.ts:267-269 REQUIREMENT_SET_MISMATCH $.semanticChecks[0].requirementIds=["req-mandate"]',
      'dev-03 B ALLOW ok UNCERTAIN UNCERTAIN decision_basis evaluate.ts:267-269 REQUIREMENT_SET_MISMATCH $.semanticChecks[0].requirementIds=["req-mandate"]',
      'dev-04 A UNCERTAIN ok UNCERTAIN UNCERTAIN decision_basis evaluate.ts:267-269 REQUIREMENT_SET_MISMATCH $.semanticChecks[0].requirementIds=["m1"]',
      'dev-04 B UNCERTAIN ok UNCERTAIN UNCERTAIN decision_basis evaluate.ts:267-269 REQUIREMENT_SET_MISMATCH $.semanticChecks[0].requirementIds=["m1"]',
      'dev-05 A BLOCK ok UNCERTAIN UNCERTAIN order_strategy_consistency evaluate.ts:277 model_status $.semanticChecks[1].status="not_applicable"',
      'dev-05 B BLOCK ok UNCERTAIN UNCERTAIN order_strategy_consistency evaluate.ts:277 model_status $.semanticChecks[1].status="not_applicable"',
      'dev-06 A ALLOW ok UNCERTAIN UNCERTAIN decision_basis evaluate.ts:267-269 REQUIREMENT_SET_MISMATCH $.semanticChecks[0].requirementIds=["m-pay"]',
      'dev-06 B ALLOW ok UNCERTAIN UNCERTAIN decision_basis evaluate.ts:267-269 REQUIREMENT_SET_MISMATCH $.semanticChecks[0].requirementIds=["req-pay-inv-440"]',
    ]);
  });

  it('proves dev-01 A needs the proposal quote after the requirement-id span is cleared', () => {
    const model = load('dev-01', 'A');
    for (const check of checksOf(model)) {
      if (check.checkId !== 'mandate_compliance') check.requirementIds = [];
    }
    expect(verdict('dev-01', model)).toBe('UNCERTAIN/UNCERTAIN');
    const decision = checksOf(model).find(check => check.checkId === 'decision_basis');
    decision?.quotes.unshift({ documentId: 'proposal', quote: 'Settle 40 EUR to Alpine Paper for bill BILL-9.' });
    expect(verdict('dev-01', model)).toBe('ALLOW/UNCERTAIN');
    model.grounding = (model.grounding as { evidenceQuote: string | null }[])
      .filter(row => !String(row.evidenceQuote).includes('not on file'));
    expect(verdict('dev-01', model)).toBe('ALLOW/ALLOW');
  });

  it('proves dev-01 B stays UNCERTAIN until strategy is applicable and the proposal is cited', () => {
    const model = load('dev-01', 'B');
    const decision = checksOf(model).find(check => check.checkId === 'decision_basis');
    if (!decision) throw new Error('decision check missing');
    decision.requirementIds = [];
    expect(verdict('dev-01', model)).toBe('UNCERTAIN/UNCERTAIN');
    const quotes = [
      { documentId: 'proposal', quote: 'Settle 40 EUR to Alpine Paper for bill BILL-9.' },
      { documentId: 'bill', quote: 'Bill BILL-9 from Alpine Paper for 40 EUR.' },
    ];
    decision.quotes = quotes;
    restoreStrategy(model, quotes);
    expect(verdict('dev-01', model)).toBe('ALLOW/ALLOW');
  });

  it('proves dev-03 reaches ALLOW once requirement ids and mandate quotes match the contract', () => {
    for (const arm of ['A', 'B'] as const) {
      const model = load('dev-03', arm);
      const decision = checksOf(model).find(check => check.checkId === 'decision_basis');
      if (!decision) throw new Error('decision check missing');
      decision.requirementIds = [];
      const proposal = { documentId: 'proposal', quote: 'Settle 15 EUR to Birch Supply for bill BILL-3.' };
      if (!decision.quotes.some(quote => quote.documentId === 'proposal')) decision.quotes.unshift(proposal);
      restoreStrategy(model, decision.quotes);
      citeMandate(model, proposal.quote, [
        { documentId: 'receipt', quote: 'Delivery receipt for bill BILL-3 from Birch Supply.' },
      ]);
      expect(verdict('dev-03', model)).toBe('ALLOW/ALLOW');
    }
  });

  it('proves dev-06 A is form first, then a pending grounding row blocks the public ALLOW', () => {
    const model = load('dev-06', 'A');
    for (const check of checksOf(model)) {
      if (check.checkId !== 'mandate_compliance') check.requirementIds = [];
    }
    expect(verdict('dev-06', model)).toBe('UNCERTAIN/UNCERTAIN');
    const proposal = 'Pay 250 EUR to Harbor Co for invoice INV-440.';
    const decision = checksOf(model).find(check => check.checkId === 'decision_basis');
    decision?.quotes.unshift({ documentId: 'proposal', quote: proposal });
    citeMandate(model, proposal);
    expect(verdict('dev-06', model)).toBe('ALLOW/UNCERTAIN');
    model.grounding = (model.grounding as { clauseQuote: string; evidenceQuote: string | null }[])
      .filter(row => !String(row.evidenceQuote).includes('still pending'));
    expect(verdict('dev-06', model)).toBe('ALLOW/UNCERTAIN');
    const cap = (model.grounding as { objectionId: string; clauseQuote: string }[])
      .find(row => row.objectionId === 'amount-cap');
    if (!cap) throw new Error('amount-cap row missing');
    cap.clauseQuote = 'The treasurer may pay invoice INV-440 up to 500 EUR to Harbor Co.';
    expect(verdict('dev-06', model)).toBe('ALLOW/ALLOW');
  });

  it('proves dev-06 B reaches ALLOW after the same citation form, without a pending row', () => {
    const model = load('dev-06', 'B');
    const decision = checksOf(model).find(check => check.checkId === 'decision_basis');
    if (!decision) throw new Error('decision check missing');
    decision.requirementIds = [];
    const quotes = [
      { documentId: 'proposal', quote: 'Pay 250 EUR to Harbor Co for invoice INV-440.' },
      { documentId: 'invoice', quote: 'Invoice INV-440 from Harbor Co for 250 EUR.' },
    ];
    decision.quotes = quotes;
    restoreStrategy(model, quotes);
    citeMandate(model, quotes[0].quote);
    expect(verdict('dev-06', model)).toBe('ALLOW/ALLOW');
  });

  it('proves dev-02 and dev-05 become BLOCK once the contradicted check cites the full requirement', () => {
    const blocked = [
      {
        caseId: 'dev-02',
        proposal: 'Settle 40 EUR to Alpine Paper for bill BILL-9.',
        source: { documentId: 'bill', quote: 'Bill BILL-9 from Alpine Paper for 40 EUR.' },
        extra: { documentId: 'bill', quote: 'The board minute is not on file.' },
      },
      {
        caseId: 'dev-05',
        proposal: 'Pay 250 EUR to Harbor Co for invoice INV-440.',
        source: { documentId: 'invoice', quote: 'Invoice INV-440 from Harbor Co for 250 EUR.' },
        extra: { documentId: 'invoice', quote: 'Second approval for INV-440 is still pending.' },
      },
    ];
    for (const item of blocked) {
      for (const arm of ['A', 'B'] as const) {
        const model = load(item.caseId, arm);
        const decision = checksOf(model).find(check => check.checkId === 'decision_basis');
        if (!decision) throw new Error('decision check missing');
        decision.requirementIds = [];
        decision.status = 'fulfilled';
        const quotes = [{ documentId: 'proposal', quote: item.proposal }, item.source];
        if (!decision.quotes.some(quote => quote.documentId === 'proposal')) decision.quotes = quotes;
        restoreStrategy(model, quotes);
        citeMandate(model, item.proposal, [item.extra]);
        expect(verdict(item.caseId, model)).toBe('BLOCK/BLOCK');
      }
    }
  });

  it('keeps dev-04 UNCERTAIN after the requirement-id span is fixed, on the model not_verifiable status', () => {
    for (const arm of ['A', 'B'] as const) {
      const model = load('dev-04', arm);
      const mandate = checksOf(model).find(check => check.checkId === 'mandate_compliance');
      expect(mandate?.status).toBe('not_verifiable');
      const decision = checksOf(model).find(check => check.checkId === 'decision_basis');
      if (!decision) throw new Error('decision check missing');
      decision.requirementIds = [];
      decision.status = 'fulfilled';
      const quotes = [
        { documentId: 'proposal', quote: 'Settle 15 EUR to Birch Supply for bill BILL-3.' },
        { documentId: 'mandate', quote: 'The clerk may settle 15 EUR to Birch Supply for bill BILL-3 only when the delivery receipt is attached.' },
      ];
      decision.quotes = quotes;
      restoreStrategy(model, quotes);
      expect(verdict('dev-04', model)).toBe('UNCERTAIN/UNCERTAIN');
      const prepared = prepareModelContent(JSON.stringify(model), caseById('dev-04').documents, 'primary');
      const gated = decideCascade(caseById('dev-04').documents, { ok: true, content: prepared.publicContent }, null, {
        trustedAdapterIds: [ADAPTER_ID], diagnostics: true,
      });
      expect(gated.diagnostics?.some(item => item.code === 'REQUIREMENT_SET_MISMATCH')).toBe(false);
      expect(gated.checks.find(check => check.checkId === 'mandate_compliance')?.status).toBe('not_verifiable');
    }
  });

  it('does not treat short 250 or 500 quotes as the first failure on dev-06 A', () => {
    const saved = JSON.parse(readFileSync(join(RAW.pathname, 'dev-06-A.json'), 'utf8')) as { content: string };
    const prepared = prepareModelContent(saved.content, caseById('dev-06').documents, 'primary');
    const gated = decideCascade(caseById('dev-06').documents, { ok: true, content: prepared.publicContent }, null, {
      trustedAdapterIds: [ADAPTER_ID], diagnostics: true,
    });
    expect(gated.checks.find(check => check.checkId === 'numeric_limits')?.status).toBe('fulfilled');
    expect(gated.checks.find(check => check.checkId === 'additional_claims')?.status).toBe('fulfilled');
  });
});
