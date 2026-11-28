import { compareDecimal, readNumericToken } from '../decimal.ts';
import type { Decision, Document } from '../contract.ts';
import { multiplyDecimal } from './decimal-mul.ts';

/** Separately versioned host check. It does not edit evaluate.ts. */
export const ORDER_VALUE_PROTO_VERSION = 'order-value-proto/v1' as const;

export type OrderValueStatus = 'fulfilled' | 'contradicted' | 'not_verifiable';

export interface OrderValueEvidence {
  documentId: string;
  quote: string;
}

export interface OrderValueCalculation {
  formula: 'quantity * limit_price';
  instrument: string;
  quantity: string;
  limitPrice: string;
  result: string;
  cap: string;
  operator: '<=';
  quantityQuote: OrderValueEvidence;
  limitPriceQuote: OrderValueEvidence;
  capQuote: OrderValueEvidence;
}

export interface OrderValueAssessment {
  version: typeof ORDER_VALUE_PROTO_VERSION;
  status: OrderValueStatus;
  reason: string;
  calculation: OrderValueCalculation | null;
  publicVerdict: Decision;
}

/**
 * Cap source. Scan source-role documents for
 * `Maximum order value EUR <decimal>` (the word inclusive may follow).
 * The decimal is one readNumericToken. The proposal must contain exactly one
 * `for <integer> <ID> at EUR <decimal> per share`. That ID must occur as a
 * whole word in the same source document as the cap. A
 * `Market price: EUR <decimal> per share.` line is never an operand.
 * Zero matches, or more than one quantity, limit price, or cap, is
 * not_verifiable. The product is quantity times the order's limit price,
 * in EUR. The cap is inclusive.
 */
const CAP = /Maximum order value EUR (\d+\.\d{2})/gi;
const OPERAND = /for (\d+) ([A-Z][A-Z0-9-]{2,}) at EUR (\d+\.\d{2}) per share/g;

function matches(text: string, pattern: RegExp): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  const copy = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = copy.exec(text)) !== null) found.push(match);
  return found;
}

function quoteOf(text: string, match: RegExpExecArray): string {
  return text.slice(match.index, match.index + match[0].length);
}

export function assessOrderValue(documents: readonly Document[]): Omit<OrderValueAssessment, 'publicVerdict'> {
  const base = { version: ORDER_VALUE_PROTO_VERSION, calculation: null as OrderValueCalculation | null };
  const caps: { documentId: string; token: string; quote: string; instrument: string | null }[] = [];
  for (const document of documents) {
    if (document.role !== 'source') continue;
    for (const match of matches(document.text, CAP)) {
      caps.push({
        documentId: document.id,
        token: match[1],
        quote: quoteOf(document.text, match),
        instrument: document.text,
      });
    }
  }
  const proposal = documents.filter(document => document.role === 'proposal');
  const operands: { documentId: string; quantity: string; instrument: string; price: string; quote: string }[] = [];
  for (const document of proposal) {
    for (const match of matches(document.text, OPERAND)) {
      operands.push({
        documentId: document.id,
        quantity: match[1],
        instrument: match[2],
        price: match[3],
        quote: quoteOf(document.text, match),
      });
    }
  }
  if (caps.length !== 1 || operands.length !== 1) {
    return { ...base, status: 'not_verifiable', reason: caps.length !== 1 ? 'cap_not_unique' : 'operand_not_unique' };
  }
  const cap = caps[0];
  const operand = operands[0];
  if (!new RegExp(`\\b${operand.instrument}\\b`).test(cap.instrument ?? '')) {
    return { ...base, status: 'not_verifiable', reason: 'instrument_not_bound' };
  }
  const capToken = readNumericToken(cap.token);
  const priceToken = readNumericToken(operand.price);
  const quantityToken = readNumericToken(operand.quantity);
  if (capToken.status !== 'exact' || priceToken.status !== 'exact' || quantityToken.status !== 'exact'
    || capToken.percent || priceToken.percent || quantityToken.percent) {
    return { ...base, status: 'not_verifiable', reason: 'token_not_exact' };
  }
  const result = multiplyDecimal(quantityToken.canonical, priceToken.canonical);
  if (result === null || compareDecimal(result, capToken.canonical) === null) {
    return { ...base, status: 'not_verifiable', reason: 'product_not_exact' };
  }
  const comparison = compareDecimal(result, capToken.canonical)!;
  const calculation: OrderValueCalculation = {
    formula: 'quantity * limit_price',
    instrument: operand.instrument,
    quantity: quantityToken.canonical,
    limitPrice: priceToken.canonical,
    result,
    cap: capToken.canonical,
    operator: '<=',
    quantityQuote: { documentId: operand.documentId, quote: operand.quote },
    limitPriceQuote: { documentId: operand.documentId, quote: operand.quote },
    capQuote: { documentId: cap.documentId, quote: cap.quote },
  };
  if (comparison > 0) return { version: ORDER_VALUE_PROTO_VERSION, status: 'contradicted', reason: 'order_value_above_cap', calculation };
  return { version: ORDER_VALUE_PROTO_VERSION, status: 'fulfilled', reason: 'order_value_within_cap', calculation };
}

/** The host may turn ALLOW into BLOCK or UNCERTAIN. It does not release a frozen non-ALLOW. */
export function applyOrderValueHost(documents: readonly Document[], frozenDecision: Decision): OrderValueAssessment {
  const check = assessOrderValue(documents);
  let publicVerdict = frozenDecision;
  if (check.status === 'contradicted') publicVerdict = 'BLOCK';
  else if (check.status === 'not_verifiable' && frozenDecision === 'ALLOW') publicVerdict = 'UNCERTAIN';
  return { ...check, publicVerdict };
}
