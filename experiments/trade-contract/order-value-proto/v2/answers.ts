import type { Document } from '../../contract.ts';
import { BOLT, BOLT_DESK, BOLT_TICKET, MANDATE, PRICE_CLAUSE, QTY_CLAUSE, STRATEGY, capSentence } from './cases.ts';

const q = (documentId: string, quote: string) => ({ documentId, quote });
const priceBinding = { subjectId: BOLT, measureId: 'limit_price', unit: 'EUR', referenceId: 'per_share' };
const qtyBinding = { subjectId: BOLT, measureId: 'share_count', unit: 'shares', referenceId: BOLT_TICKET };
const valueBinding = { subjectId: BOLT, measureId: 'order_value', unit: 'EUR', referenceId: BOLT_TICKET };

export interface AnswerOptions {
  includeCapLimit?: boolean;
  mandateStatus?: 'fulfilled' | 'contradicted';
  cap?: string;
}

/** Extractor answer. The order-value sentence is not a requirement quote unless a limit is added. */
export function boltAnswer(documents: readonly Document[], quantity: string, price: string, options?: AnswerOptions): unknown {
  const ids = documents.map(document => document.id);
  const orderLine = `Limit buy for ${quantity} ${BOLT} at EUR ${price} per share.`;
  const mandateStatus = options?.mandateStatus ?? 'fulfilled';
  const limits: {
    id: string; binding: typeof valueBinding; operator: '<='; value: string; numberReading: 'unambiguous';
    valueQuote: { documentId: string; quote: string }; bindingQuotes: { documentId: string; quote: string }[];
    referenceQuote: null; quantityId: string | null;
  }[] = [
    {
      id: 'lim-px', binding: priceBinding, operator: '<=', value: '50.00', numberReading: 'unambiguous',
      valueQuote: q(BOLT_DESK, '50.00'),
      bindingQuotes: [q(BOLT_DESK, PRICE_CLAUSE)],
      referenceQuote: null,
      quantityId: 'qty-px',
    },
    {
      id: 'lim-qty', binding: qtyBinding, operator: '<=', value: '80', numberReading: 'unambiguous',
      valueQuote: q(BOLT_DESK, '80'),
      bindingQuotes: [q(BOLT_DESK, QTY_CLAUSE)],
      referenceQuote: null,
      quantityId: 'qty-n',
    },
  ];
  if (options?.includeCapLimit) {
    const cap = options.cap ?? '1000.00';
    limits.push({
      id: 'lim-notional', binding: valueBinding, operator: '<=', value: cap, numberReading: 'unambiguous',
      valueQuote: q(BOLT_DESK, cap),
      bindingQuotes: [q(BOLT_DESK, capSentence(cap))],
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
      { id: 'buy-shelf', kind: 'strategy', sourceHeading: null, decidedBy: 'clause', quotes: [q(BOLT_DESK, STRATEGY)] },
      { id: 'buy-only', kind: 'mandate', sourceHeading: null, decidedBy: 'clause', quotes: [q(BOLT_DESK, MANDATE)] },
      { id: 'px-cap', kind: 'mandate', sourceHeading: null, decidedBy: 'clause', quotes: [q(BOLT_DESK, PRICE_CLAUSE)] },
      { id: 'n-cap', kind: 'mandate', sourceHeading: null, decidedBy: 'clause', quotes: [q(BOLT_DESK, QTY_CLAUSE)] },
    ],
    semanticChecks: [
      { checkId: 'decision_basis', status: 'fulfilled', requirementIds: [], quotes: [q(BOLT_TICKET, orderLine), q(BOLT_DESK, STRATEGY)] },
      { checkId: 'order_strategy_consistency', status: 'fulfilled', requirementIds: ['buy-shelf'], quotes: [q(BOLT_TICKET, orderLine), q(BOLT_DESK, STRATEGY)] },
      { checkId: 'mandate_compliance', status: mandateStatus, requirementIds: ['buy-only', 'px-cap', 'n-cap'], quotes: [q(BOLT_TICKET, orderLine), q(BOLT_DESK, MANDATE), q(BOLT_DESK, PRICE_CLAUSE), q(BOLT_DESK, QTY_CLAUSE)] },
    ],
    claims: [],
    quantities: [
      {
        id: 'qty-px', binding: priceBinding, value: price, numberReading: 'unambiguous',
        valueQuote: q(BOLT_TICKET, price),
        bindingQuotes: [q(BOLT_TICKET, `at EUR ${price} per share`)],
        referenceQuote: null,
      },
      {
        id: 'qty-n', binding: qtyBinding, value: quantity, numberReading: 'unambiguous',
        valueQuote: q(BOLT_TICKET, quantity),
        bindingQuotes: [q(BOLT_TICKET, `for ${quantity} ${BOLT}`)],
        referenceQuote: null,
      },
    ],
    limits,
  };
}
