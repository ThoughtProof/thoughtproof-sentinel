import type { Document } from '../../contract.ts';
import { MANDATE_TEXT, PRICE_CLAUSE, RIVET, RIVET_DESK, RIVET_TICKET, STRATEGY } from './packet.ts';
import type { Operator } from './host.ts';

const q = (documentId: string, quote: string) => ({ documentId, quote });

export interface ExtraLimit {
  id: string;
  measure: string;
  unit: string;
  referenceId: string;
  operator: Operator;
  value: string;
  documentId: string;
  bindingQuote: string;
  valueQuote: string;
}

/** Extractor answer written after the mandate packet. Host clauses are omitted unless extra limits are passed. */
export function rivetAnswer(
  documents: readonly Document[],
  quantity: string,
  price: string,
  options?: { mandateStatus?: 'fulfilled' | 'contradicted'; extraLimits?: ExtraLimit[] },
): Record<string, unknown> {
  const ids = documents.map(document => document.id);
  const orderLine = `Limit buy for ${quantity} ${RIVET} at EUR ${price} per share.`;
  const priceBinding = { subjectId: RIVET, measureId: 'limit_price', unit: 'EUR', referenceId: 'per_share' };
  const limits: Record<string, unknown>[] = [
    {
      id: 'lim-px', binding: priceBinding, operator: '<=', value: '50.00', numberReading: 'unambiguous',
      valueQuote: q(RIVET_DESK, '50.00'),
      bindingQuotes: [q(RIVET_DESK, PRICE_CLAUSE)],
      referenceQuote: null,
      quantityId: 'qty-px',
    },
  ];
  for (const extra of options?.extraLimits ?? []) {
    limits.push({
      id: extra.id,
      binding: { subjectId: RIVET, measureId: extra.measure, unit: extra.unit, referenceId: extra.referenceId },
      operator: extra.operator, value: extra.value, numberReading: 'unambiguous',
      valueQuote: q(extra.documentId, extra.valueQuote),
      bindingQuotes: [q(extra.documentId, extra.bindingQuote)],
      referenceQuote: null,
      quantityId: null,
    });
  }
  return {
    version: 'trade-contract-adapter/v1',
    complete: true,
    applicability: [
      ['decision_basis', 'applicable', 'mandatory'],
      ['order_strategy_consistency', 'applicable', 'mandatory'],
      ['mandate_compliance', 'applicable', 'explicit_items'],
      ['additional_claims', 'not_applicable', 'none_in_complete_scope'],
      ['numeric_limits', 'applicable', 'explicit_items'],
    ].map(([checkId, status, basis]) => ({ checkId, status, basis, documentIds: ids, complete: true })),
    detection: [
      { checkId: 'mandate_compliance', state: 'complete', result: 'found' },
      { checkId: 'numeric_limits', state: 'complete', result: 'found' },
      { checkId: 'additional_claims', state: 'complete', result: 'none' },
    ],
    requirements: [
      { id: 'buy-rivet', kind: 'strategy', sourceHeading: null, decidedBy: 'clause', quotes: [q(RIVET_DESK, STRATEGY)] },
      { id: 'buy-only', kind: 'mandate', sourceHeading: null, decidedBy: 'clause', quotes: [q(RIVET_DESK, MANDATE_TEXT)] },
      { id: 'px-cap', kind: 'mandate', sourceHeading: null, decidedBy: 'clause', quotes: [q(RIVET_DESK, PRICE_CLAUSE)] },
    ],
    semanticChecks: [
      { checkId: 'decision_basis', status: 'fulfilled', requirementIds: [], quotes: [q(RIVET_TICKET, orderLine), q(RIVET_DESK, STRATEGY)] },
      { checkId: 'order_strategy_consistency', status: 'fulfilled', requirementIds: ['buy-rivet'], quotes: [q(RIVET_TICKET, orderLine), q(RIVET_DESK, STRATEGY)] },
      {
        checkId: 'mandate_compliance', status: options?.mandateStatus ?? 'fulfilled', requirementIds: ['buy-only', 'px-cap'],
        quotes: [q(RIVET_TICKET, orderLine), q(RIVET_DESK, MANDATE_TEXT), q(RIVET_DESK, PRICE_CLAUSE)],
      },
    ],
    claims: [],
    quantities: [
      {
        id: 'qty-px', binding: priceBinding, value: price, numberReading: 'unambiguous',
        valueQuote: q(RIVET_TICKET, price),
        bindingQuotes: [q(RIVET_TICKET, `at EUR ${price} per share`)],
        referenceQuote: null,
      },
    ],
    limits,
  };
}
