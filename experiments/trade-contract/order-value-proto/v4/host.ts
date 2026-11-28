import { ADAPTER_ID, decideCascade } from '../../adapter.ts';
import { prepareModelContent, quoteBlocksRelease, type GroundingRow } from '../../comparison-grounding.ts';
import type { Decision, Document, Status } from '../../contract.ts';
import { compareDecimal, readNumericToken } from '../../decimal.ts';
import { uniqueQuoteSpan } from '../../spans.ts';
import { multiplyDecimal } from './decimal-mul.ts';

/**
 * order-value-proto/v4. The frozen evaluator and comparison-grounding.ts
 * are not edited.
 *
 * The executable mode is both clause enforcement and the quantity-grounding
 * release. A mode with the release on and clause enforcement off is not a
 * member of SafeMode, and rejectUnsafe throws if it is forced through.
 *
 * An extractor limit is removed only when it is the unique assignment of
 * one authorized clause of this order: same document and unique clause span,
 * measure, unit, operator and value. referenceId counts only when it is an
 * order reference in the packet. Any other assignment leaves the limit in place.
 *
 * A grounding row is released only when quoteBlocksRelease blocks solely
 * because comparison-grounding.ts:93 finds no shared word, the quantity
 * comparison passed, and the complete evidence quote is a unique span in
 * the order document containing the quantity operand and the instrument id.
 */
export const ORDER_VALUE_PROTO_VERSION = 'order-value-proto/v4' as const;

export type Operator = '<' | '<=' | '>' | '>=' | '==';

/** Diagnostic modes. The release is never on while clause enforcement is off. */
export type SafeMode =
  | { readonly clauseBinding: false; readonly quantityGrounding: false }
  | { readonly clauseBinding: true; readonly quantityGrounding: false }
  | { readonly clauseBinding: true; readonly quantityGrounding: true };

export const EXECUTABLE_MODE = { clauseBinding: true, quantityGrounding: true } as const satisfies SafeMode;

export function rejectUnsafe(mode: { clauseBinding: boolean; quantityGrounding: boolean }): SafeMode {
  if (mode.quantityGrounding && !mode.clauseBinding) throw new Error('UNSAFE_EXECUTABLE_MODE');
  if (!mode.clauseBinding && !mode.quantityGrounding) return { clauseBinding: false, quantityGrounding: false };
  if (mode.clauseBinding && !mode.quantityGrounding) return { clauseBinding: true, quantityGrounding: false };
  return EXECUTABLE_MODE;
}

export interface AuthorizedClause {
  clauseId: string;
  orderRef: string;
  instrument: string;
  measure: string;
  unit: string;
  operator: Operator;
  limitValue: string;
  kind: 'quantity' | 'order_value';
  source: { documentId: string; quote: string };
}

export interface MandatePacket {
  orderRef: string;
  instrument: string;
  currency: string;
  clauses: AuthorizedClause[];
}

export interface OrderUnderReview {
  orderRef: string;
  instrument: string;
  currency: string;
  side: 'buy' | 'sell';
  proposalDocumentId: string;
  quantity: { value: string; quote: string };
  limitPrice: { value: string; quote: string };
}

export interface ClauseProof {
  clauseId: string;
  orderRef: string;
  instrument: string;
  unit: string;
  operator: Operator;
  limitValue: string;
  status: Status;
  reason: string;
  operand: string | null;
}

export type GroundingReason =
  | 'clear'
  | 'reading_open_or_violated'
  | 'evidence_missing'
  | 'clause_span'
  | 'evidence_span'
  | 'open_condition'
  | 'no_shared_word'
  | 'quantity_span_proven';

export interface GroundingNote {
  index: number;
  blocks: boolean;
  reason: GroundingReason;
  clauseId: string | null;
}

export interface PublicComposition {
  version: typeof ORDER_VALUE_PROTO_VERSION;
  mode: SafeMode;
  frozenVerdict: Decision;
  numericBefore: Status;
  numericAfter: Status;
  proofs: ClauseProof[];
  replacedLimitIds: string[];
  grounding: GroundingNote[];
  publicVerdict: Decision;
  blockers: { checkId: string; status: Status }[];
}

const OPEN_CONDITION = /\b(?:pending|not on file|still pending)\b/i;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/\p{L}{5,}/gu) ?? []);
}

function sharesContentWord(left: string, right: string): boolean {
  const rightWords = words(right);
  for (const word of words(left)) if (rightWords.has(word)) return true;
  return false;
}

function spanOk(documents: readonly Document[], id: string, quote: string): boolean {
  if (quote.trim().length === 0) return false;
  const document = documents.find(item => item.id === id);
  return !!document && uniqueQuoteSpan(document.text, quote) !== null;
}

/** Same order as quoteBlocksRelease. Only no_shared_word is line 93. */
export function frozenGroundingReason(row: GroundingRow, documents: readonly Document[]): GroundingReason {
  if (row.reading === 'open' || row.reading === 'violated') return 'reading_open_or_violated';
  if (row.evidenceQuote === null || row.evidenceDocumentId === null) return 'evidence_missing';
  if (!spanOk(documents, row.clauseDocumentId, row.clauseQuote)) return 'clause_span';
  if (!spanOk(documents, row.evidenceDocumentId, row.evidenceQuote)) return 'evidence_span';
  if (OPEN_CONDITION.test(row.evidenceQuote)) return 'open_condition';
  if (!sharesContentWord(row.clauseQuote, row.evidenceQuote)) return 'no_shared_word';
  return 'clear';
}

function aggregate(statuses: Status[]): Status {
  if (statuses.includes('contradicted')) return 'contradicted';
  if (statuses.length === 0 || statuses.includes('not_verifiable')) return 'not_verifiable';
  return statuses.every(status => status === 'not_applicable') ? 'not_applicable' : 'fulfilled';
}

function finish(checks: { status: Status }[]): Decision {
  if (checks.some(check => check.status === 'contradicted')) return 'BLOCK';
  if (checks.some(check => check.status === 'not_verifiable')) return 'UNCERTAIN';
  return 'ALLOW';
}

function quoteCarries(quote: string, value: string): boolean {
  const token = readNumericToken(value);
  if (token.status !== 'exact' || token.percent) return false;
  let from = 0;
  while (from <= quote.length - value.length) {
    const at = quote.indexOf(value, from);
    if (at < 0) return false;
    const before = quote[at - 1] ?? '';
    const after = quote[at + value.length] ?? '';
    if (!/\d/.test(before) && !/\d/.test(after)) return true;
    from = at + 1;
  }
  return false;
}

function hasToken(quote: string, token: string): boolean {
  const at = quote.indexOf(token);
  if (at < 0) return false;
  const before = quote[at - 1] ?? '';
  const after = quote[at + token.length] ?? '';
  return !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
}

function evaluateClause(documents: readonly Document[], order: OrderUnderReview, item: AuthorizedClause): ClauseProof {
  const proof: ClauseProof = {
    clauseId: item.clauseId, orderRef: item.orderRef, instrument: item.instrument,
    unit: item.unit, operator: item.operator, limitValue: item.limitValue,
    status: 'not_verifiable', reason: 'unbound', operand: null,
  };
  if (item.orderRef !== order.orderRef || item.instrument !== order.instrument) {
    return { ...proof, status: 'not_applicable', reason: 'other_order' };
  }
  if (!spanOk(documents, item.source.documentId, item.source.quote) || !quoteCarries(item.source.quote, item.limitValue)) {
    return { ...proof, reason: 'clause_unproven' };
  }
  if (!spanOk(documents, order.proposalDocumentId, order.quantity.quote) || !quoteCarries(order.quantity.quote, order.quantity.value)
    || !hasToken(order.quantity.quote, order.instrument)) {
    return { ...proof, reason: 'quantity_unproven' };
  }
  if (item.kind === 'quantity') {
    if (item.unit !== 'shares') return { ...proof, reason: 'unit_mismatch' };
    const token = readNumericToken(order.quantity.value);
    if (token.status !== 'exact') return { ...proof, reason: 'token_not_exact' };
    const comparison = compareDecimal(token.canonical, item.limitValue);
    if (comparison === null) return { ...proof, reason: 'comparison_not_exact' };
    const ok = item.operator === '<' ? comparison < 0 : item.operator === '<=' ? comparison <= 0
      : item.operator === '>' ? comparison > 0 : item.operator === '>=' ? comparison >= 0 : comparison === 0;
    return { ...proof, status: ok ? 'fulfilled' : 'contradicted', operand: token.canonical, reason: ok ? 'quantity_within_cap' : 'quantity_outside_cap' };
  }
  if (item.unit !== order.currency || !spanOk(documents, order.proposalDocumentId, order.limitPrice.quote)) {
    return { ...proof, reason: 'price_unproven' };
  }
  const shares = readNumericToken(order.quantity.value);
  const price = readNumericToken(order.limitPrice.value);
  if (shares.status !== 'exact' || price.status !== 'exact') return { ...proof, reason: 'token_not_exact' };
  const product = multiplyDecimal(shares.canonical, price.canonical);
  if (!product) return { ...proof, reason: 'product_not_exact' };
  const comparison = compareDecimal(product, item.limitValue);
  if (comparison === null) return { ...proof, reason: 'comparison_not_exact' };
  const ok = item.operator === '<' ? comparison < 0 : item.operator === '<=' ? comparison <= 0
    : item.operator === '>' ? comparison > 0 : item.operator === '>=' ? comparison >= 0 : comparison === 0;
  return { ...proof, status: ok ? 'fulfilled' : 'contradicted', operand: product, reason: ok ? 'order_value_within_cap' : 'order_value_outside_cap' };
}

interface ModelLimit {
  id: string;
  binding: { subjectId: string; measureId: string; unit: string; referenceId: string };
  operator: Operator;
  value: string;
  bindingQuotes: { documentId: string; quote: string }[];
}

function limitMatches(limit: ModelLimit, item: AuthorizedClause, mandate: MandatePacket, documents: readonly Document[]): boolean {
  const refs = new Set(mandate.clauses.map(clause => clause.orderRef));
  if (refs.has(limit.binding.referenceId) && limit.binding.referenceId !== item.orderRef) return false;
  return limit.binding.subjectId === item.instrument
    && limit.binding.measureId === item.measure
    && limit.binding.unit === item.unit
    && limit.operator === item.operator
    && compareDecimal(limit.value, item.limitValue) === 0
    && limit.bindingQuotes.some(quote => quote.documentId === item.source.documentId && quote.quote === item.source.quote)
    && spanOk(documents, item.source.documentId, item.source.quote);
}

function replacedIds(limits: readonly ModelLimit[], mandate: MandatePacket, order: OrderUnderReview, documents: readonly Document[]): string[] {
  const pairs: { limitId: string; clauseId: string; applies: boolean }[] = [];
  for (const item of mandate.clauses) {
    for (const limit of limits) {
      if (!limitMatches(limit, item, mandate, documents)) continue;
      pairs.push({
        limitId: limit.id, clauseId: item.clauseId,
        applies: item.orderRef === order.orderRef && item.instrument === order.instrument,
      });
    }
  }
  return limits.map(limit => limit.id).filter(id => {
    const hits = pairs.filter(pair => pair.limitId === id);
    if (hits.length !== 1 || !hits[0].applies) return false;
    return pairs.filter(pair => pair.clauseId === hits[0].clauseId).length === 1;
  });
}

function evidenceProvesQuantity(quote: string, order: OrderUnderReview, documents: readonly Document[]): boolean {
  if (!spanOk(documents, order.proposalDocumentId, quote)) return false;
  return quote.includes(order.quantity.quote) && hasToken(quote, order.instrument) && quoteCarries(order.quantity.quote, order.quantity.value);
}

function groundingNote(
  row: GroundingRow, documents: readonly Document[], mandate: MandatePacket,
  order: OrderUnderReview, proofs: readonly ClauseProof[], mode: SafeMode,
): { blocks: boolean; reason: GroundingReason; clauseId: string | null } {
  const reason = frozenGroundingReason(row, documents);
  if (quoteBlocksRelease(row, documents) !== (reason !== 'clear')) {
    return { blocks: true, reason: 'clause_span', clauseId: null };
  }
  if (reason !== 'no_shared_word' || !mode.quantityGrounding) return { blocks: reason !== 'clear', reason, clauseId: null };
  const passed = proofs.filter(proof => proof.status === 'fulfilled' && proof.unit === 'shares' && proof.orderRef === order.orderRef);
  const matched = mandate.clauses.filter(item => item.kind === 'quantity' && item.orderRef === order.orderRef
    && row.clauseDocumentId === item.source.documentId && row.clauseQuote === item.source.quote
    && passed.some(proof => proof.clauseId === item.clauseId));
  if (matched.length !== 1 || row.evidenceQuote === null || !evidenceProvesQuantity(row.evidenceQuote, order, documents)) {
    return { blocks: true, reason, clauseId: matched.length === 1 ? matched[0].clauseId : null };
  }
  return { blocks: false, reason: 'quantity_span_proven', clauseId: matched[0].clauseId };
}

export function composePublic(
  documents: readonly Document[], content: string, mandate: MandatePacket,
  order: OrderUnderReview, mode: SafeMode,
): PublicComposition {
  const safe = rejectUnsafe(mode);
  const prepared = prepareModelContent(content, documents, 'primary');
  const frozen = decideCascade(documents, { ok: true, content: prepared.publicContent }, null, {
    trustedAdapterIds: [ADAPTER_ID], diagnostics: true,
  });
  const proofs = mandate.clauses.map(item => evaluateClause(documents, order, item));
  const numericBefore = frozen.checks.find(check => check.checkId === 'numeric_limits')?.status ?? 'not_verifiable';
  const model = JSON.parse(prepared.publicContent) as { limits: ModelLimit[] };
  const replacedLimitIds = safe.clauseBinding ? replacedIds(model.limits, mandate, order, documents) : [];
  let numericAfter = numericBefore;
  if (safe.clauseBinding) {
    model.limits = model.limits.filter(limit => !replacedLimitIds.includes(limit.id));
    const others = decideCascade(documents, { ok: true, content: JSON.stringify(model) }, null, {
      trustedAdapterIds: [ADAPTER_ID],
    }).checks.find(check => check.checkId === 'numeric_limits')?.status ?? 'not_verifiable';
    const host = proofs.filter(proof => proof.status !== 'not_applicable').map(proof => proof.status);
    numericAfter = aggregate([others, ...host]);
  }
  const checks = frozen.checks.map(check => check.checkId === 'numeric_limits' ? { ...check, status: numericAfter } : check);
  const decision = finish(checks);
  const grounding = prepared.grounding.map((row, index) => ({ index, ...groundingNote(row, documents, mandate, order, proofs, safe) }));
  const blocked = decision === 'ALLOW' && grounding.some(note => note.blocks);
  const publicVerdict: Decision = blocked ? 'UNCERTAIN' : decision;
  const blockers: { checkId: string; status: Status }[] = checks
    .filter(check => check.status === 'contradicted' || check.status === 'not_verifiable')
    .map(check => ({ checkId: check.checkId, status: check.status }));
  if (blocked) blockers.push({ checkId: 'grounding', status: 'not_verifiable' });
  return {
    version: ORDER_VALUE_PROTO_VERSION, mode: safe, frozenVerdict: frozen.decision,
    numericBefore, numericAfter, proofs, replacedLimitIds, grounding, publicVerdict, blockers,
  };
}
