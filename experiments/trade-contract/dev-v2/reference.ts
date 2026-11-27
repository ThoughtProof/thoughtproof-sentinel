import { ADAPTER_OUTPUT_VERSION } from '../adapter.ts';
import type { GroundingRow } from '../comparison-grounding.ts';
import {
  BASIS_TEXT, MANDATE_APPROVAL, MANDATE_SOLE, NOTICE_PENDING, ORDER_CASES, ORDER_TEXT,
  STRATEGY_INCREASE, STRATEGY_REDUCE, orderCaseById,
} from './cases.ts';

type Quote = { documentId: string; quote: string };

function q(documentId: string, quote: string): Quote {
  return { documentId, quote };
}

function answer(input: {
  caseId: string;
  requirements: { id: string; kind: 'strategy' | 'mandate'; quotes: Quote[] }[];
  decisionQuotes: Quote[];
  strategyStatus: 'fulfilled' | 'contradicted' | 'not_verifiable';
  strategyIds: string[];
  strategyQuotes: Quote[];
  mandateStatus: 'fulfilled' | 'contradicted';
  mandateIds: string[];
  mandateQuotes: Quote[];
  grounding: GroundingRow[];
}): string {
  const documents = orderCaseById(input.caseId).documents;
  const documentIds = documents.map(document => document.id);
  return JSON.stringify({
    version: ADAPTER_OUTPUT_VERSION,
    complete: true,
    grounding: input.grounding,
    applicability: [
      { checkId: 'decision_basis', status: 'applicable', basis: 'mandatory', documentIds, complete: true },
      { checkId: 'order_strategy_consistency', status: 'applicable', basis: 'mandatory', documentIds, complete: true },
      { checkId: 'mandate_compliance', status: 'applicable', basis: 'explicit_items', documentIds, complete: true },
      { checkId: 'additional_claims', status: 'not_applicable', basis: 'none_in_complete_scope', documentIds, complete: true },
      { checkId: 'numeric_limits', status: 'not_applicable', basis: 'none_in_complete_scope', documentIds, complete: true },
    ],
    detection: [
      { checkId: 'mandate_compliance', state: 'complete', result: 'found' },
      { checkId: 'numeric_limits', state: 'complete', result: 'none' },
      { checkId: 'additional_claims', state: 'complete', result: 'none' },
    ],
    requirements: input.requirements.map(item => ({
      id: item.id, kind: item.kind, sourceHeading: null, decidedBy: 'clause', quotes: item.quotes,
    })),
    semanticChecks: [
      { checkId: 'decision_basis', status: 'fulfilled', quotes: input.decisionQuotes, requirementIds: [] },
      {
        checkId: 'order_strategy_consistency', status: input.strategyStatus,
        quotes: input.strategyQuotes, requirementIds: input.strategyIds,
      },
      {
        checkId: 'mandate_compliance', status: input.mandateStatus,
        quotes: input.mandateQuotes, requirementIds: input.mandateIds,
      },
    ],
    claims: [],
    quantities: [],
    limits: [],
  });
}

const orderQuote = q('order', ORDER_TEXT);
const basisQuote = q('basis', BASIS_TEXT);
const reduceQuote = q('strategy', STRATEGY_REDUCE);
const soleQuote = q('mandate', MANDATE_SOLE);
const metSole: GroundingRow = {
  objectionId: 'sole-authority',
  clauseDocumentId: 'mandate',
  clauseQuote: MANDATE_SOLE,
  evidenceDocumentId: 'order',
  evidenceQuote: ORDER_TEXT,
  reading: 'met',
};

/** Honest reference JSON for one trade-order case. Quotes are spans of that case only. */
export function orderReference(caseId: string): string {
  if (!ORDER_CASES.some(item => item.caseId === caseId)) throw new Error('UNKNOWN_ORDER_CASE');
  if (caseId === 'ord-01' || caseId === 'ord-03' || caseId === 'ord-05') {
    return answer({
      caseId,
      requirements: [
        { id: 'reduce-helio', kind: 'strategy', quotes: [reduceQuote] },
        { id: 'sole-authority', kind: 'mandate', quotes: [soleQuote] },
      ],
      decisionQuotes: [orderQuote, basisQuote],
      strategyStatus: 'fulfilled',
      strategyIds: ['reduce-helio'],
      strategyQuotes: [orderQuote, reduceQuote],
      mandateStatus: 'fulfilled',
      mandateIds: ['sole-authority'],
      mandateQuotes: [orderQuote, soleQuote],
      grounding: [metSole],
    });
  }
  if (caseId === 'ord-02') {
    return answer({
      caseId,
      requirements: [
        { id: 'reduce-helio', kind: 'strategy', quotes: [reduceQuote] },
        { id: 'need-approval', kind: 'mandate', quotes: [q('mandate', MANDATE_APPROVAL)] },
      ],
      decisionQuotes: [orderQuote, basisQuote],
      strategyStatus: 'fulfilled',
      strategyIds: ['reduce-helio'],
      strategyQuotes: [orderQuote, reduceQuote],
      mandateStatus: 'contradicted',
      mandateIds: ['need-approval'],
      mandateQuotes: [orderQuote, q('mandate', MANDATE_APPROVAL), q('notice', NOTICE_PENDING)],
      grounding: [{
        objectionId: 'need-approval',
        clauseDocumentId: 'mandate',
        clauseQuote: MANDATE_APPROVAL,
        evidenceDocumentId: 'notice',
        evidenceQuote: NOTICE_PENDING,
        reading: 'violated',
      }],
    });
  }
  if (caseId === 'ord-04') {
    return answer({
      caseId,
      requirements: [{ id: 'sole-authority', kind: 'mandate', quotes: [soleQuote] }],
      decisionQuotes: [orderQuote, basisQuote],
      strategyStatus: 'not_verifiable',
      strategyIds: [],
      strategyQuotes: [],
      mandateStatus: 'fulfilled',
      mandateIds: ['sole-authority'],
      mandateQuotes: [orderQuote, soleQuote],
      grounding: [metSole],
    });
  }
  return answer({
    caseId,
    requirements: [
      { id: 'increase-helio', kind: 'strategy', quotes: [q('strategy', STRATEGY_INCREASE)] },
      { id: 'sole-authority', kind: 'mandate', quotes: [soleQuote] },
    ],
    decisionQuotes: [orderQuote, basisQuote],
    strategyStatus: 'contradicted',
    strategyIds: ['increase-helio'],
    strategyQuotes: [orderQuote, q('strategy', STRATEGY_INCREASE)],
    mandateStatus: 'fulfilled',
    mandateIds: ['sole-authority'],
    mandateQuotes: [orderQuote, soleQuote],
    grounding: [{
      objectionId: 'increase-helio',
      clauseDocumentId: 'strategy',
      clauseQuote: STRATEGY_INCREASE,
      evidenceDocumentId: 'order',
      evidenceQuote: ORDER_TEXT,
      reading: 'violated',
    }],
  });
}
