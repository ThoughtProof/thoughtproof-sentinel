import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADAPTER_ID, decideCascade } from './adapter.ts';
import { buildArmRequest } from './comparison-run.ts';
import { deterministicPrecheckPasses } from './comparison-precheck.ts';
import { prepareModelContent } from './comparison-grounding.ts';
import { assessModelText } from './comparison-report.ts';
import {
  HOLDINGS_QUOTE, HOLDINGS_TEXT, ORDER_CASES, orderCaseById,
} from './dev-v3/cases.ts';
import { ORDER_LABELS } from './dev-v3/labels.ts';
import { orderReference } from './dev-v3/reference.ts';
import {
  MANDATE_APPROVAL, MANDATE_SOLE, P3_STRATEGY_INCREASE, P3_STRATEGY_REDUCE, STRATEGY_REDUCE,
} from './dev-v2/cases.ts';

function source(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8');
}

function gated(caseId: string, content: string) {
  const documents = orderCaseById(caseId).documents;
  const prepared = prepareModelContent(content, documents, 'primary');
  return decideCascade(documents, { ok: true, content: prepared.publicContent }, null, {
    trustedAdapterIds: [ADAPTER_ID], diagnostics: true,
  });
}

describe('dev-v3 trade orders', () => {
  it('adds the same holdings source to every case and leaves the other documents', () => {
    expect(ORDER_CASES).toHaveLength(6);
    const holdings = ORDER_CASES.map(item => item.documents.find(document => document.id === 'holdings')?.text);
    expect(new Set(holdings)).toEqual(new Set([HOLDINGS_TEXT]));
    for (const item of ORDER_CASES) {
      expect(deterministicPrecheckPasses(item.precheck)).toBe(true);
      const prior = item.documents.filter(document => document.id !== 'holdings');
      expect(prior.some(document => document.text === HOLDINGS_TEXT)).toBe(false);
    }
    expect(orderCaseById('v3-05').documents.find(document => document.id === 'book')?.text)
      .toBe('The position is held in the main book.');
    expect(orderCaseById('v3-03').documents.some(document => document.id === 'book')).toBe(false);
  });

  it('keeps pair ids, sealed labels, and the other variant out of the model input', () => {
    expect(source('./dev-v3/cases.ts')).not.toContain('ORDER_LABELS');
    expect(source('./dev-v3/cases.ts')).not.toContain('dev-v3/labels');
    expect(source('./comparison-run.ts')).not.toContain('dev-v3/labels');
    expect(source('./comparison-plan.ts')).not.toContain('dev-v3/labels');
    for (const item of ORDER_CASES) {
      for (const arm of ['A', 'B'] as const) {
        const payload = buildArmRequest(item.documents, arm).messages[1].content;
        expect(payload).not.toContain(item.caseId);
        expect(payload).not.toContain('SEALED:');
        expect(payload).not.toContain('pairId');
        expect(payload).not.toContain('P1');
        expect(payload).not.toContain('expected');
        expect(payload).not.toContain('counterpart');
        for (const label of ORDER_LABELS) {
          if (label.caseId === item.caseId) continue;
          for (const document of orderCaseById(label.caseId).documents) {
            if (item.documents.some(row => row.text === document.text)) continue;
            expect(payload).not.toContain(document.text);
          }
        }
      }
    }
  });

  it('isolates each pair in the built request', () => {
    const pairs = [
      ['v3-01', 'v3-02', MANDATE_SOLE, MANDATE_APPROVAL],
      ['v3-05', 'v3-06', P3_STRATEGY_REDUCE, P3_STRATEGY_INCREASE],
    ] as const;
    for (const [leftId, rightId, from, to] of pairs) {
      for (const arm of ['A', 'B'] as const) {
        const left = JSON.stringify(buildArmRequest(orderCaseById(leftId).documents, arm));
        const right = JSON.stringify(buildArmRequest(orderCaseById(rightId).documents, arm));
        expect(left.includes(from)).toBe(true);
        expect(left.includes(to)).toBe(false);
        expect(left.replace(from, to)).toBe(right);
      }
    }
    const withStrategy = orderCaseById('v3-03').documents;
    const without = orderCaseById('v3-04').documents;
    expect(withStrategy.filter(document => document.id !== 'strategy')).toEqual(without);
    expect(without.some(document => document.text === STRATEGY_REDUCE)).toBe(false);
    for (const arm of ['A', 'B'] as const) {
      const bodies = ORDER_CASES.map(item => JSON.stringify(buildArmRequest(item.documents, arm)));
      expect(new Set(bodies).size).toBe(6);
    }
  });

  it('reaches each sealed public verdict and fulfills the holdings claim', () => {
    for (const label of ORDER_LABELS) {
      const item = orderCaseById(label.caseId);
      const content = orderReference(label.caseId);
      const model = JSON.parse(content) as {
        claims: { claimQuote: { quote: string }; supportingQuotes: { documentId: string; quote: string }[]; status: string }[];
        grounding: { clauseQuote: string; evidenceQuote: string | null }[];
        requirements: { quotes: { quote: string }[] }[];
        semanticChecks: { quotes: { quote: string }[] }[];
      };
      expect(model.claims.length).toBeGreaterThan(0);
      const supplied = item.documents.map(document => document.text);
      const quotes = [
        ...model.claims.flatMap(claim => [claim.claimQuote.quote, ...claim.supportingQuotes.map(quote => quote.quote)]),
        ...model.requirements.flatMap(row => row.quotes.map(quote => quote.quote)),
        ...model.semanticChecks.flatMap(row => row.quotes.map(quote => quote.quote)),
        ...model.grounding.flatMap(row => [row.clauseQuote, row.evidenceQuote].filter((quote): quote is string => quote !== null)),
      ];
      for (const quote of quotes) expect(supplied.some(text => text.includes(quote))).toBe(true);
      const assessed = assessModelText(item.documents, content);
      expect(assessed.parserResult).toBe('ok');
      expect(assessed.frozenGateVerdict).toBe(label.expected);
      expect(assessed.publicVerdict).toBe(label.expected);
      const result = gated(label.caseId, content);
      expect(result.checks.find(check => check.checkId === label.decisiveCheckId)?.status).toBe(label.decisiveStatus);
      expect(result.checks.find(check => check.checkId === 'additional_claims')?.status).toBe('fulfilled');
    }
    const ord05 = JSON.parse(orderReference('v3-05')) as {
      claims: { claimQuote: { documentId: string; quote: string }; supportingQuotes: { documentId: string; quote: string }[]; status: string }[];
    };
    expect(ord05.claims[0].claimQuote).toEqual({ documentId: 'order', quote: HOLDINGS_QUOTE });
    expect(ord05.claims[0].supportingQuotes).toEqual([{ documentId: 'holdings', quote: HOLDINGS_QUOTE }]);
    expect(ord05.claims[0].status).toBe('fulfilled');
    expect(gated('v3-05', orderReference('v3-05')).checks.find(check => check.checkId === 'additional_claims')?.status)
      .toBe('fulfilled');
  });

  it('does not let the holdings quote satisfy approval, strategy absence, or a contradiction', () => {
    const approval = JSON.parse(orderReference('v3-02')) as {
      semanticChecks: { checkId: string; status: string; quotes: { documentId: string; quote: string }[] }[];
    };
    const mandate = approval.semanticChecks.find(check => check.checkId === 'mandate_compliance');
    if (!mandate) throw new Error('mandate missing');
    mandate.status = 'fulfilled';
    mandate.quotes = [
      { documentId: 'order', quote: 'Sell 10 of the 40 Helio shares with a limit order.' },
      { documentId: 'holdings', quote: HOLDINGS_QUOTE },
    ];
    expect(assessModelText(orderCaseById('v3-02').documents, JSON.stringify(approval)).publicVerdict).not.toBe('ALLOW');

    const missing = JSON.parse(orderReference('v3-04')) as {
      semanticChecks: { checkId: string; status: string; quotes: { documentId: string; quote: string }[]; requirementIds: string[] }[];
    };
    const strategy = missing.semanticChecks.find(check => check.checkId === 'order_strategy_consistency');
    if (!strategy) throw new Error('strategy missing');
    strategy.status = 'fulfilled';
    strategy.requirementIds = ['held-as-strategy'];
    strategy.quotes = [
      { documentId: 'order', quote: 'Sell 10 of the 40 Helio shares with a limit order.' },
      { documentId: 'holdings', quote: HOLDINGS_QUOTE },
    ];
    expect(assessModelText(orderCaseById('v3-04').documents, JSON.stringify(missing)).publicVerdict).toBe('UNCERTAIN');

    const opposed = JSON.parse(orderReference('v3-06')) as {
      semanticChecks: { checkId: string; status: string; quotes: { documentId: string; quote: string }[] }[];
    };
    const opposedStrategy = opposed.semanticChecks.find(check => check.checkId === 'order_strategy_consistency');
    if (!opposedStrategy) throw new Error('strategy missing');
    opposedStrategy.status = 'fulfilled';
    opposedStrategy.quotes = [
      { documentId: 'order', quote: 'Sell 10 of the 40 Helio shares with a limit order.' },
      { documentId: 'holdings', quote: HOLDINGS_QUOTE },
    ];
    expect(assessModelText(orderCaseById('v3-06').documents, JSON.stringify(opposed)).publicVerdict).not.toBe('ALLOW');
  });
});
