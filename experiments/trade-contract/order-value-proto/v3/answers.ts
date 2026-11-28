import type { Document } from '../../contract.ts';
import { COIL, COIL_DESK, COIL_TICKET, MANDATE, PRICE_CLAUSE, STRATEGY } from './packet.ts';

const q = (documentId: string, quote: string) => ({ documentId, quote });
const priceBinding = { subjectId: COIL, measureId: 'limit_price', unit: 'EUR', referenceId: 'per_share' };

/** Extractor answer built after the mandate packet. Quantity and order-value caps are omitted unless asked. */
export function coilAnswer(
  documents: readonly Document[],
  quantity: string,
  price: string,
  options?: { mandateStatus?: 'fulfilled' | 'contradicted' },
): unknown {
  const ids = documents.map(document => document.id);
  const orderLine = `Limit buy for ${quantity} ${COIL} at EUR ${price} per share.`;
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
      { id: 'buy-coil', kind: 'strategy', sourceHeading: null, decidedBy: 'clause', quotes: [q(COIL_DESK, STRATEGY)] },
      { id: 'buy-only', kind: 'mandate', sourceHeading: null, decidedBy: 'clause', quotes: [q(COIL_DESK, MANDATE)] },
      { id: 'px-cap', kind: 'mandate', sourceHeading: null, decidedBy: 'clause', quotes: [q(COIL_DESK, PRICE_CLAUSE)] },
    ],
    semanticChecks: [
      { checkId: 'decision_basis', status: 'fulfilled', requirementIds: [], quotes: [q(COIL_TICKET, orderLine), q(COIL_DESK, STRATEGY)] },
      { checkId: 'order_strategy_consistency', status: 'fulfilled', requirementIds: ['buy-coil'], quotes: [q(COIL_TICKET, orderLine), q(COIL_DESK, STRATEGY)] },
      {
        checkId: 'mandate_compliance',
        status: options?.mandateStatus ?? 'fulfilled',
        requirementIds: ['buy-only', 'px-cap'],
        quotes: [q(COIL_TICKET, orderLine), q(COIL_DESK, MANDATE), q(COIL_DESK, PRICE_CLAUSE)],
      },
    ],
    claims: [],
    quantities: [
      {
        id: 'qty-px', binding: priceBinding, value: price, numberReading: 'unambiguous',
        valueQuote: q(COIL_TICKET, price),
        bindingQuotes: [q(COIL_TICKET, `at EUR ${price} per share`)],
        referenceQuote: null,
      },
    ],
    limits: [
      {
        id: 'lim-px', binding: priceBinding, operator: '<=', value: '50.00', numberReading: 'unambiguous',
        valueQuote: q(COIL_DESK, '50.00'),
        bindingQuotes: [q(COIL_DESK, PRICE_CLAUSE)],
        referenceQuote: null,
        quantityId: 'qty-px',
      },
    ],
  };
}
