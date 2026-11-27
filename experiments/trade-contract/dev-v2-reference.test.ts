import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADAPTER_ID, decideCascade } from './adapter.ts';
import { buildArmRequest } from './comparison-run.ts';
import { deterministicPrecheckPasses } from './comparison-precheck.ts';
import { prepareModelContent } from './comparison-grounding.ts';
import { assessModelText } from './comparison-report.ts';
import { casesFor } from './comparison-cases.ts';
import {
  BASIS_TEXT, MANDATE_APPROVAL, MANDATE_SOLE, NOTICE_PENDING, ORDER_CASES, ORDER_TEXT,
  STRATEGY_INCREASE, STRATEGY_REDUCE, orderCaseById,
} from './dev-v2/cases.ts';
import { ORDER_LABELS } from './dev-v2/labels.ts';
import { orderReference } from './dev-v2/reference.ts';

function source(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8');
}

describe('dev-v2 trade orders', () => {
  it('passes the deterministic prechecks and keeps the payment set at six cases', () => {
    expect(casesFor('dev')).toHaveLength(6);
    expect(ORDER_CASES).toHaveLength(6);
    for (const item of ORDER_CASES) expect(deterministicPrecheckPasses(item.precheck)).toBe(true);
  });

  it('changes exactly one document inside each pair and shares the order', () => {
    const pairs = [['ord-01', 'ord-02'], ['ord-03', 'ord-04'], ['ord-05', 'ord-06']];
    for (const [leftId, rightId] of pairs) {
      const left = orderCaseById(leftId!).documents;
      const right = orderCaseById(rightId!).documents;
      expect(left.find(document => document.id === 'order')!.text).toBe(ORDER_TEXT);
      expect(right.find(document => document.id === 'order')!.text).toBe(ORDER_TEXT);
      const leftText = new Map(left.map(document => [document.id, document.text]));
      const rightText = new Map(right.map(document => [document.id, document.text]));
      const ids = new Set([...leftText.keys(), ...rightText.keys()]);
      const changed = [...ids].filter(id => leftText.get(id) !== rightText.get(id));
      expect(changed).toHaveLength(1);
    }
  });

  it('keeps pair ids, sealed labels, and the other variant out of the model input', () => {
    expect(source('./dev-v2/cases.ts')).not.toContain('ORDER_LABELS');
    expect(source('./dev-v2/cases.ts')).not.toContain('dev-v2/labels');
    expect(source('./comparison-prompt.ts')).not.toContain('ord-0');
    expect(source('./comparison-run.ts')).not.toContain('dev-v2/labels');
    for (const item of ORDER_CASES) {
      for (const arm of ['A', 'B'] as const) {
        const payload = buildArmRequest(item.documents, arm).messages[1].content;
        const parsed = JSON.parse(payload) as { id: string; role: string; text: string }[];
        expect(parsed.every(row => Object.keys(row).sort().join() === 'id,role,text')).toBe(true);
        expect(payload).not.toContain(item.caseId);
        expect(payload).not.toContain('SEALED:');
        expect(payload).not.toContain('pairId');
        expect(payload).not.toContain('P1');
        expect(payload).not.toContain('expected');
        expect(payload).not.toContain('counterpart');
        for (const label of ORDER_LABELS) {
          if (label.caseId === item.caseId) continue;
          const other = orderCaseById(label.caseId);
          for (const document of other.documents) {
            if (leftShared(item.documents, document.text)) continue;
            expect(payload).not.toContain(document.text);
          }
        }
      }
    }
  });

  it('reaches each sealed public verdict for the sealed check, with verbatim quotes', () => {
    for (const label of ORDER_LABELS) {
      const item = orderCaseById(label.caseId);
      const content = orderReference(label.caseId);
      const model = JSON.parse(content) as {
        grounding: { clauseQuote: string; evidenceQuote: string | null }[];
        requirements: { quotes: { quote: string }[] }[];
        semanticChecks: { checkId: string; status: string; quotes: { quote: string }[] }[];
      };
      const supplied = item.documents.map(document => document.text);
      const quotes = [
        ...model.requirements.flatMap(row => row.quotes.map(quote => quote.quote)),
        ...model.semanticChecks.flatMap(row => row.quotes.map(quote => quote.quote)),
        ...model.grounding.flatMap(row => [row.clauseQuote, row.evidenceQuote].filter((quote): quote is string => quote !== null)),
      ];
      for (const quote of quotes) expect(supplied.some(text => text.includes(quote))).toBe(true);
      const assessed = assessModelText(item.documents, content);
      expect(assessed.parserResult).toBe('ok');
      expect(assessed.frozenGateVerdict).toBe(label.expected);
      expect(assessed.publicVerdict).toBe(label.expected);
      const prepared = prepareModelContent(content, item.documents, 'primary');
      const gated = decideCascade(item.documents, { ok: true, content: prepared.publicContent }, null, {
        trustedAdapterIds: [ADAPTER_ID], diagnostics: true,
      });
      const decisive = gated.checks.find(check => check.checkId === label.decisiveCheckId);
      expect(decisive?.status).toBe(label.decisiveStatus);
      if (label.expected === 'UNCERTAIN') {
        const earlier = gated.checks.slice(0, gated.checks.findIndex(check => check.checkId === label.decisiveCheckId));
        expect(earlier.every(check => check.status === 'fulfilled' || check.status === 'not_applicable')).toBe(true);
        expect(gated.checks.some(check => check.status === 'contradicted')).toBe(false);
      }
      if (label.expected === 'ALLOW') expect(assessed.publicVerdict).toBe('ALLOW');
    }
    expect(BASIS_TEXT.includes('Helio demand')).toBe(true);
    expect(STRATEGY_REDUCE.includes('Reduce')).toBe(true);
    expect(STRATEGY_INCREASE.includes('Increase')).toBe(true);
    expect(MANDATE_SOLE.includes('sole authority')).toBe(true);
    expect(MANDATE_APPROVAL.includes('second approval')).toBe(true);
    expect(NOTICE_PENDING.includes('still pending')).toBe(true);
  });
});

function leftShared(documents: { text: string }[], text: string): boolean {
  return documents.some(document => document.text === text);
}
