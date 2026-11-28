import type { Document } from '../../contract.ts';
import type { AuthorizedClause, MandatePacket, OrderUnderReview } from './host.ts';

/** Synthetic buy. The mandate packet is built before any model answer. */
export const COIL = 'SYNTH-COIL';
export const COIL_DESK = 'coil-desk';
export const COIL_TICKET = 'coil-ticket';

export const STRATEGY = `Strategy: Buy ${COIL} to fill the coil trial.`;
export const MANDATE = `Mandate: Buy only ${COIL}.`;
export const PRICE_CLAUSE = 'Maximum buy limit EUR 50.00 per share.';
export const QTY_QUOTE = 'Maximum quantity 80 shares.';
export const VALUE_QUOTE = 'Maximum order value EUR 1000.00 inclusive.';
export const QTY_STRICT_QUOTE = 'Quantity must stay under 80 shares.';
export const QTY_INCLUSIVE_QUOTE = 'Quantity may reach 80 shares.';

export function clause(partial: Omit<AuthorizedClause, 'orderRef' | 'instrument' | 'source'> & { quote: string; clauseId: string }): AuthorizedClause {
  return {
    clauseId: partial.clauseId,
    orderRef: COIL_TICKET,
    instrument: COIL,
    unit: partial.unit,
    operator: partial.operator,
    limitValue: partial.limitValue,
    kind: partial.kind,
    source: { documentId: COIL_DESK, quote: partial.quote },
  };
}

export function standardClauses(): AuthorizedClause[] {
  return [
    clause({ clauseId: 'qty-cap', kind: 'quantity', unit: 'shares', operator: '<=', limitValue: '80', quote: QTY_QUOTE }),
    clause({ clauseId: 'value-cap', kind: 'order_value', unit: 'EUR', operator: '<=', limitValue: '1000.00', quote: VALUE_QUOTE }),
  ];
}

export function boundaryClauses(): AuthorizedClause[] {
  return [
    clause({ clauseId: 'qty-strict', kind: 'quantity', unit: 'shares', operator: '<', limitValue: '80', quote: QTY_STRICT_QUOTE }),
    clause({ clauseId: 'qty-inclusive', kind: 'quantity', unit: 'shares', operator: '<=', limitValue: '80', quote: QTY_INCLUSIVE_QUOTE }),
    clause({ clauseId: 'value-cap', kind: 'order_value', unit: 'EUR', operator: '<=', limitValue: '1000.00', quote: VALUE_QUOTE }),
  ];
}

export function packetOf(clauses: AuthorizedClause[]): MandatePacket {
  return { orderRef: COIL_TICKET, instrument: COIL, currency: 'EUR', clauses };
}

/** Desk text is the packet's own clause quotes, then the order. */
export function documentsFor(mandate: MandatePacket, quantity: string, limitPrice: string): Document[] {
  const desk = [
    `Instrument: ${mandate.instrument}.`,
    STRATEGY,
    MANDATE,
    PRICE_CLAUSE,
    ...mandate.clauses.map(item => item.source.quote),
  ].join('\n') + '\n';
  const ticket = `Limit buy for ${quantity} ${mandate.instrument} at EUR ${limitPrice} per share.\n`;
  return [
    { id: COIL_DESK, role: 'source', text: desk },
    { id: COIL_TICKET, role: 'proposal', text: ticket },
  ];
}

export function orderFor(quantity: string, limitPrice: string): OrderUnderReview {
  return {
    orderRef: COIL_TICKET,
    instrument: COIL,
    currency: 'EUR',
    side: 'buy',
    proposalDocumentId: COIL_TICKET,
    quantity: { value: quantity, quote: `for ${quantity} ${COIL}` },
    limitPrice: { value: limitPrice, quote: `at EUR ${limitPrice} per share` },
  };
}
