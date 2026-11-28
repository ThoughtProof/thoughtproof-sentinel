import type { Document } from '../../contract.ts';
import type { AuthorizedClause, MandatePacket, OrderUnderReview } from './host.ts';

/** Synthetic buy. The mandate packet is built before any model answer. */
export const RIVET = 'SYNTH-RIVET';
export const RIVET_DESK = 'rivet-desk';
export const RIVET_TICKET = 'rivet-ticket';
export const OTHER_TICKET = 'other-ticket';
export const OTHER_DESK = 'other-desk';

export const STRATEGY = `Strategy: Buy ${RIVET} to stock the rivet trial.`;
export const MANDATE_TEXT = `Mandate: Buy only ${RIVET}.`;
export const PRICE_CLAUSE = 'Maximum buy limit EUR 50.00 per share.';
export const QTY_QUOTE = 'Maximum quantity 80 shares.';
export const VALUE_QUOTE = 'Maximum order value EUR 1000.00 inclusive.';

export function clause(partial: {
  clauseId: string;
  kind: AuthorizedClause['kind'];
  measure: string;
  unit: string;
  operator: AuthorizedClause['operator'];
  limitValue: string;
  quote: string;
  orderRef?: string;
  documentId?: string;
}): AuthorizedClause {
  return {
    clauseId: partial.clauseId,
    orderRef: partial.orderRef ?? RIVET_TICKET,
    instrument: RIVET,
    measure: partial.measure,
    unit: partial.unit,
    operator: partial.operator,
    limitValue: partial.limitValue,
    kind: partial.kind,
    source: { documentId: partial.documentId ?? RIVET_DESK, quote: partial.quote },
  };
}

/** Authorized clauses exist before the extractor answer is written. */
export function standardPacket(): MandatePacket {
  return {
    orderRef: RIVET_TICKET,
    instrument: RIVET,
    currency: 'EUR',
    clauses: [
      clause({ clauseId: 'qty-cap', kind: 'quantity', measure: 'share_count', unit: 'shares', operator: '<=', limitValue: '80', quote: QTY_QUOTE }),
      clause({ clauseId: 'value-cap', kind: 'order_value', measure: 'order_value', unit: 'EUR', operator: '<=', limitValue: '1000.00', quote: VALUE_QUOTE }),
    ],
  };
}

export function packetWithOtherOrder(): MandatePacket {
  const packet = standardPacket();
  packet.clauses.push(clause({
    clauseId: 'qty-other-order', kind: 'quantity', measure: 'share_count', unit: 'shares',
    operator: '<=', limitValue: '80', quote: QTY_QUOTE, orderRef: OTHER_TICKET, documentId: OTHER_DESK,
  }));
  return packet;
}

export function documentsFor(mandate: MandatePacket, quantity: string, limitPrice: string): Document[] {
  const groups = new Map<string, string[]>();
  for (const item of mandate.clauses) {
    const list = groups.get(item.source.documentId) ?? [];
    if (!list.includes(item.source.quote)) list.push(item.source.quote);
    groups.set(item.source.documentId, list);
  }
  const desk = [
    `Instrument: ${mandate.instrument}.`,
    STRATEGY,
    MANDATE_TEXT,
    PRICE_CLAUSE,
    ...(groups.get(RIVET_DESK) ?? []),
  ].join('\n') + '\n';
  groups.delete(RIVET_DESK);
  const documents: Document[] = [{ id: RIVET_DESK, role: 'source', text: desk }];
  for (const [id, quotes] of groups) documents.push({ id, role: 'source', text: quotes.join('\n') + '\n' });
  documents.push({
    id: RIVET_TICKET, role: 'proposal',
    text: `Limit buy for ${quantity} ${mandate.instrument} at EUR ${limitPrice} per share.\n`,
  });
  return documents;
}

export function orderFor(quantity: string, limitPrice: string): OrderUnderReview {
  return {
    orderRef: RIVET_TICKET,
    instrument: RIVET,
    currency: 'EUR',
    side: 'buy',
    proposalDocumentId: RIVET_TICKET,
    quantity: { value: quantity, quote: `for ${quantity} ${RIVET}` },
    limitPrice: { value: limitPrice, quote: `at EUR ${limitPrice} per share` },
  };
}

export function orderSentence(quantity: string, limitPrice: string): string {
  return `Limit buy for ${quantity} ${RIVET} at EUR ${limitPrice} per share.`;
}
