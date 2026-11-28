import type { Document } from '../../contract.ts';
import type { AuthorizedLimitRecord, AuthorizedLimitsPacket, OrderUnderReview } from './host.ts';

/** Synthetic buy of an invented instrument. The strategy says to buy. */
export const BOLT = 'SYNTH-BOLT';
export const BOLT_DESK = 'bolt-desk';
export const BOLT_TICKET = 'bolt-ticket';
export const ORDER_CAP = '1000.00';

export const STRATEGY = `Strategy: Buy ${BOLT} to fill the trial shelf.`;
export const MANDATE = `Mandate: Buy only ${BOLT}.`;
export const PRICE_CLAUSE = 'Maximum buy limit EUR 50.00 per share.';
export const QTY_CLAUSE = 'Maximum quantity 80 shares.';

export function capSentence(value = ORDER_CAP): string {
  return `Maximum order value EUR ${value} inclusive.`;
}

export function boltDocuments(quantity: string, limitPrice: string, extra = ''): Document[] {
  const desk = [
    `Instrument: ${BOLT}.`,
    STRATEGY,
    MANDATE,
    PRICE_CLAUSE,
    QTY_CLAUSE,
    capSentence(),
    'Forecast: the shelf may reach EUR 1000.00 next quarter.',
    extra,
  ].filter(Boolean).join('\n') + '\n';
  const ticket = `Limit buy for ${quantity} ${BOLT} at EUR ${limitPrice} per share.\n`;
  return [
    { id: BOLT_DESK, role: 'source', text: desk },
    { id: BOLT_TICKET, role: 'proposal', text: ticket },
  ];
}

export function orderCap(options?: Partial<AuthorizedLimitRecord>): AuthorizedLimitRecord {
  return {
    kind: 'order_value',
    purpose: 'order_cap',
    instrument: BOLT,
    currency: 'EUR',
    orderRef: BOLT_TICKET,
    value: ORDER_CAP,
    inclusive: true,
    source: { documentId: BOLT_DESK, quote: capSentence() },
    ...options,
  };
}

export function boltPacket(records?: AuthorizedLimitRecord[]): AuthorizedLimitsPacket {
  return {
    requiredFor: { side: 'buy', instrument: BOLT, currency: 'EUR' },
    records: records ?? [
      orderCap(),
      orderCap({
        purpose: 'forecast',
        orderRef: 'forecast-shelf',
        source: { documentId: BOLT_DESK, quote: 'Forecast: the shelf may reach EUR 1000.00 next quarter.' },
      }),
    ],
  };
}

export function boltOrder(quantity: string, limitPrice: string, options?: Partial<OrderUnderReview>): OrderUnderReview {
  return {
    orderRef: BOLT_TICKET,
    instrument: BOLT,
    currency: 'EUR',
    side: 'buy',
    proposalDocumentId: BOLT_TICKET,
    quantity: { value: quantity, quote: `for ${quantity} ${BOLT}` },
    limitPrice: { value: limitPrice, quote: `at EUR ${limitPrice} per share` },
    ...options,
  };
}
