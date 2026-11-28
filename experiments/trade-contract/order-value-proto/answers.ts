import type { Document } from '../contract.ts';
import { SYNTH_INSTRUMENT } from './cases.ts';

const q = (documentId: string, quote: string) => ({ documentId, quote });
const priceBinding = { subjectId: SYNTH_INSTRUMENT, measureId: 'limit_price', unit: 'EUR', referenceId: 'per_share' };
const qtyBinding = { subjectId: SYNTH_INSTRUMENT, measureId: 'share_count', unit: 'shares', referenceId: 'order' };
const valueBinding = { subjectId: SYNTH_INSTRUMENT, measureId: 'order_value', unit: 'EUR', referenceId: 'order' };

/** Extractor answer for the frozen gate. The order-value sentence is not a requirement quote. */
export function extractorAnswer(documents: readonly Document[], options?: { includeCapLimit?: boolean; cap?: string }): unknown {
  const ids = documents.map(document => document.id);
  const quantity = /for (\d+) /.exec(documents.find(document => document.role === 'proposal')!.text)![1];
  const price = /at EUR (\d+\.\d{2}) per share/.exec(documents.find(document => document.role === 'proposal')!.text)![1];
  const orderLine = `Limit buy for ${quantity} ${SYNTH_INSTRUMENT} at EUR ${price} per share.`;
  const strategy = `Strategy: Reduce ${SYNTH_INSTRUMENT} inventory because the trial batch is finished.`;
  const mandate = `Mandate: Do not sell ${SYNTH_INSTRUMENT}.`;
  const priceClause = 'Maximum buy limit EUR 50.00 per share.';
  const qtyClause = 'Maximum quantity 80 shares.';
  const limits = [
    {
      id: 'lim-px', binding: priceBinding, operator: '<=', value: '50.00', numberReading: 'unambiguous',
      valueQuote: q('syn-desk', '50.00'),
      bindingQuotes: [q('syn-desk', priceClause)],
      referenceQuote: null,
      quantityId: 'qty-px',
    },
    {
      id: 'lim-qty', binding: qtyBinding, operator: '<=',       value: '80', numberReading: 'unambiguous',
      valueQuote: q('syn-desk', '80'),
      bindingQuotes: [q('syn-desk', qtyClause)],
      referenceQuote: null,
      quantityId: 'qty-n',
    },
  ];
  if (options?.includeCapLimit) {
    const cap = options.cap ?? '1000.00';
    limits.push({
      id: 'lim-notional', binding: valueBinding, operator: '<=', value: cap, numberReading: 'unambiguous',
      valueQuote: q('syn-desk', cap),
      bindingQuotes: [q('syn-desk', `Maximum order value EUR ${cap} inclusive.`)],
      referenceQuote: null,
      quantityId: null as unknown as string,
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
      { id: 'reduce', kind: 'strategy', sourceHeading: null, decidedBy: 'clause', quotes: [q('syn-desk', strategy)] },
      { id: 'no-sell', kind: 'mandate', sourceHeading: null, decidedBy: 'clause', quotes: [q('syn-desk', mandate)] },
      { id: 'px-cap', kind: 'mandate', sourceHeading: null, decidedBy: 'clause', quotes: [q('syn-desk', priceClause)] },
      { id: 'n-cap', kind: 'mandate', sourceHeading: null, decidedBy: 'clause', quotes: [q('syn-desk', qtyClause)] },
    ],
    semanticChecks: [
      { checkId: 'decision_basis', status: 'fulfilled', requirementIds: [], quotes: [q('syn-ticket', orderLine), q('syn-desk', strategy)] },
      { checkId: 'order_strategy_consistency', status: 'fulfilled', requirementIds: ['reduce'], quotes: [q('syn-ticket', orderLine), q('syn-desk', strategy)] },
      { checkId: 'mandate_compliance', status: 'fulfilled', requirementIds: ['no-sell', 'px-cap', 'n-cap'], quotes: [q('syn-ticket', orderLine), q('syn-desk', mandate), q('syn-desk', priceClause), q('syn-desk', qtyClause)] },
    ],
    claims: [],
    quantities: [
      {
        id: 'qty-px', binding: priceBinding, value: price, numberReading: 'unambiguous',
        valueQuote: q('syn-ticket', price),
        bindingQuotes: [q('syn-ticket', `at EUR ${price} per share`)],
        referenceQuote: null,
      },
      {
        id: 'qty-n', binding: qtyBinding, value: quantity, numberReading: 'unambiguous',
        valueQuote: q('syn-ticket', quantity),
        bindingQuotes: [q('syn-ticket', `for ${quantity} ${SYNTH_INSTRUMENT}`)],
        referenceQuote: null,
      },
    ],
    limits,
  };
}
