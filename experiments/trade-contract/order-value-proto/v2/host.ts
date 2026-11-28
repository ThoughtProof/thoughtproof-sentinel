import { ADAPTER_ID, decideCascade } from '../../adapter.ts';
import { applySharedHost, prepareModelContent } from '../../comparison-grounding.ts';
import type { Decision, Document, Status } from '../../contract.ts';
import { compareDecimal, readNumericToken } from '../../decimal.ts';
import { uniqueQuoteSpan } from '../../spans.ts';
import { multiplyDecimal } from './decimal-mul.ts';

/**
 * order-value-proto/v2. The frozen evaluator is not edited.
 *
 * The single replaced member is the numeric limit identified by all of:
 * binding.measureId === 'order_value', binding.subjectId === the order
 * instrument, and binding.unit === the order currency. Exactly one such
 * limit is replaced. Zero means the extractor omitted it, and this layer
 * inserts that one member before aggregation. More than one is ambiguous
 * and the member stays not_verifiable.
 *
 * The replacement value is quantity × the order's limit price, compared
 * with the one structured authorized cap. Every other limit is re-read by
 * decideCascade on the same answer with those order-value limits removed.
 * Mandate, strategy, decision basis, and grounding rows are the original
 * frozen results. A fulfilled product does not clear them.
 */
export const ORDER_VALUE_PROTO_VERSION = 'order-value-proto/v2' as const;

export const REPLACED_MEMBER = {
  checkId: 'numeric_limits',
  measureId: 'order_value',
} as const;

export interface AuthorizedLimitRecord {
  kind: 'order_value';
  purpose: 'order_cap' | 'forecast' | 'foreign_policy';
  instrument: string;
  currency: string;
  orderRef: string;
  value: string;
  inclusive: boolean;
  source: { documentId: string; quote: string };
}

export interface AuthorizedLimitsPacket {
  /** A buy of this instrument in this currency requires one order_cap. Anything else is not_applicable. */
  requiredFor: { side: 'buy'; instrument: string; currency: string };
  records: AuthorizedLimitRecord[];
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

export interface OrderValueCalculation {
  formula: 'quantity * limit_price';
  quantity: string;
  limitPrice: string;
  result: string;
  cap: string;
  inclusive: boolean;
  quantityQuote: { documentId: string; quote: string };
  limitPriceQuote: { documentId: string; quote: string };
  capQuote: { documentId: string; quote: string };
}

export interface MemberReplacement {
  checkId: 'numeric_limits';
  measureId: 'order_value';
  limitId: string | null;
  before: Status | 'omitted';
  after: Status;
  reason: string;
}

export interface PublicComposition {
  version: typeof ORDER_VALUE_PROTO_VERSION;
  frozenVerdict: Decision;
  numericBefore: Status;
  numericAfter: Status;
  replaced: MemberReplacement;
  calculation: OrderValueCalculation | null;
  publicVerdict: Decision;
  blockers: { checkId: string; status: Status }[];
}

interface Binding {
  subjectId: string;
  measureId: string;
  unit: string;
  referenceId: string;
}
interface ModelLimit {
  id: string;
  binding: Binding;
  operator: '<' | '<=' | '>' | '>=' | '==';
  value: string;
  quantityId: string | null;
}
interface ModelQuantity {
  id: string;
  binding: Binding;
  value: string;
  valueQuote?: { documentId: string };
}
interface ModelAnswer {
  limits: ModelLimit[];
  quantities: ModelQuantity[];
}

function aggregate(statuses: Status[]): Status {
  if (statuses.includes('contradicted')) return 'contradicted';
  if (statuses.length === 0 || statuses.includes('not_verifiable')) return 'not_verifiable';
  return statuses.every(status => status === 'not_applicable') ? 'not_applicable' : 'fulfilled';
}

function finish(checks: { checkId: string; status: Status }[]): Decision {
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

function provenSource(documents: readonly Document[], source: { documentId: string; quote: string }, value: string): boolean {
  const document = documents.find(item => item.id === source.documentId);
  if (!document || document.role !== 'source') return false;
  if (!uniqueQuoteSpan(document.text, source.quote)) return false;
  return quoteCarries(source.quote, value);
}

function provenProposal(documents: readonly Document[], order: OrderUnderReview, field: { value: string; quote: string }): boolean {
  const document = documents.find(item => item.id === order.proposalDocumentId);
  if (!document || document.role !== 'proposal') return false;
  if (!uniqueQuoteSpan(document.text, field.quote)) return false;
  return quoteCarries(field.quote, field.value);
}

export interface CapBinding {
  status: Status;
  reason: string;
  record: AuthorizedLimitRecord | null;
}

/** Forecasts and foreign-policy records never bind, even when the number is identical. */
export function bindAuthorizedCap(
  documents: readonly Document[],
  packet: AuthorizedLimitsPacket,
  order: OrderUnderReview,
): CapBinding {
  const required = packet.requiredFor;
  if (order.side !== required.side || order.instrument !== required.instrument || order.currency !== required.currency) {
    return { status: 'not_applicable', reason: 'cap_not_applicable', record: null };
  }
  const aimed = packet.records.filter(record =>
    record.kind === 'order_value'
    && record.purpose === 'order_cap'
    && record.instrument === order.instrument
    && record.currency === order.currency
    && record.orderRef === order.orderRef);
  const proven = aimed.filter(record => provenSource(documents, record.source, record.value));
  const unproven = aimed.length - proven.length;
  if (unproven > 0) return { status: 'not_verifiable', reason: 'cap_unproven', record: null };
  if (proven.length === 0) return { status: 'not_verifiable', reason: 'cap_missing', record: null };
  if (proven.length > 1) return { status: 'not_verifiable', reason: 'cap_ambiguous', record: null };
  return { status: 'fulfilled', reason: 'cap_bound', record: proven[0] };
}

function sameBinding(left: Binding, right: Binding): boolean {
  return left.subjectId === right.subjectId && left.measureId === right.measureId
    && left.unit === right.unit && left.referenceId === right.referenceId;
}

function memberBefore(model: ModelAnswer, index: number, diagnostics: { path: string }[]): Status | 'omitted' {
  if (index < 0) return 'omitted';
  if (diagnostics.some(item => item.path === `$.limits[${index}]`)) return 'not_verifiable';
  const limit = model.limits[index];
  const quantity = model.quantities.find(item => item.id === limit.quantityId);
  if (!quantity || !sameBinding(quantity.binding, limit.binding)) return 'not_verifiable';
  const comparison = compareDecimal(quantity.value, limit.value);
  if (comparison === null) return 'not_verifiable';
  const ok = limit.operator === '<' ? comparison < 0
    : limit.operator === '<=' ? comparison <= 0
      : limit.operator === '>' ? comparison > 0
        : limit.operator === '>=' ? comparison >= 0 : comparison === 0;
  return ok ? 'fulfilled' : 'contradicted';
}

function isOrderValueLimit(limit: ModelLimit, order: OrderUnderReview): boolean {
  return limit.binding.measureId === REPLACED_MEMBER.measureId
    && limit.binding.subjectId === order.instrument
    && limit.binding.unit === order.currency;
}

interface Product {
  status: Status;
  reason: string;
  calculation: OrderValueCalculation | null;
}

function productStatus(
  documents: readonly Document[],
  model: ModelAnswer,
  order: OrderUnderReview,
  cap: CapBinding,
): Product {
  if (cap.status === 'not_applicable') return { status: 'not_applicable', reason: cap.reason, calculation: null };
  if (!cap.record) return { status: 'not_verifiable', reason: cap.reason, calculation: null };
  if (!provenProposal(documents, order, order.quantity) || !provenProposal(documents, order, order.limitPrice)) {
    return { status: 'not_verifiable', reason: 'operand_unproven', calculation: null };
  }
  // A price quoted on another document is not this order's limit price.
  const onOrder = (item: ModelQuantity) => item.valueQuote?.documentId === order.proposalDocumentId;
  const prices = model.quantities.filter(item => item.binding.subjectId === order.instrument && item.binding.unit === order.currency && onOrder(item));
  const shares = model.quantities.filter(item => item.binding.subjectId === order.instrument && item.binding.unit === 'shares' && onOrder(item));
  const priceToken = readNumericToken(order.limitPrice.value);
  const shareToken = readNumericToken(order.quantity.value);
  const capToken = readNumericToken(cap.record.value);
  if (priceToken.status !== 'exact' || shareToken.status !== 'exact' || capToken.status !== 'exact') {
    return { status: 'not_verifiable', reason: 'token_not_exact', calculation: null };
  }
  if (prices.length > 1 || shares.length > 1) return { status: 'not_verifiable', reason: 'operand_not_unique', calculation: null };
  if (prices.length === 1 && compareDecimal(prices[0].value, priceToken.canonical) !== 0) {
    return { status: 'not_verifiable', reason: 'operand_conflict', calculation: null };
  }
  if (shares.length === 1 && compareDecimal(shares[0].value, shareToken.canonical) !== 0) {
    return { status: 'not_verifiable', reason: 'operand_conflict', calculation: null };
  }
  if (cap.record.inclusive !== true && cap.record.inclusive !== false) {
    return { status: 'not_verifiable', reason: 'cap_inclusivity_missing', calculation: null };
  }
  const listed = model.limits.filter(limit => isOrderValueLimit(limit, order));
  if (listed.length === 1 && compareDecimal(listed[0].value, capToken.canonical) !== 0) {
    return { status: 'not_verifiable', reason: 'listed_cap_disagrees', calculation: null };
  }
  const result = multiplyDecimal(shareToken.canonical, priceToken.canonical);
  if (result === null || compareDecimal(result, capToken.canonical) === null) {
    return { status: 'not_verifiable', reason: 'product_not_exact', calculation: null };
  }
  const comparison = compareDecimal(result, capToken.canonical)!;
  const calculation: OrderValueCalculation = {
    formula: 'quantity * limit_price',
    quantity: shareToken.canonical,
    limitPrice: priceToken.canonical,
    result,
    cap: capToken.canonical,
    inclusive: cap.record.inclusive,
    quantityQuote: { documentId: order.proposalDocumentId, quote: order.quantity.quote },
    limitPriceQuote: { documentId: order.proposalDocumentId, quote: order.limitPrice.quote },
    capQuote: cap.record.source,
  };
  const above = cap.record.inclusive ? comparison > 0 : comparison >= 0;
  return {
    status: above ? 'contradicted' : 'fulfilled',
    reason: above ? 'order_value_above_cap' : 'order_value_within_cap',
    calculation,
  };
}

/** Frozen checks, then the one order-value member, then the same aggregation the gate uses. */
export function composePublic(
  documents: readonly Document[],
  content: string,
  packet: AuthorizedLimitsPacket,
  order: OrderUnderReview,
): PublicComposition {
  const prepared = prepareModelContent(content, documents, 'primary');
  const frozen = decideCascade(documents, { ok: true, content: prepared.publicContent }, null, {
    trustedAdapterIds: [ADAPTER_ID], diagnostics: true,
  });
  const model = JSON.parse(prepared.publicContent) as ModelAnswer;
  const indexes = model.limits.map((limit, index) => isOrderValueLimit(limit, order) ? index : -1).filter(index => index >= 0);
  const cap = bindAuthorizedCap(documents, packet, order);
  const product = productStatus(documents, model, order, cap);
  const numericBefore = frozen.checks.find(check => check.checkId === 'numeric_limits')?.status ?? 'not_verifiable';
  let numericAfter = numericBefore;
  let before: Status | 'omitted' = indexes.length === 0 ? 'omitted' : 'not_verifiable';
  if (indexes.length > 1) {
    before = 'not_verifiable';
    numericAfter = 'not_verifiable';
    product.status = 'not_verifiable';
    product.reason = 'order_value_not_unique';
  } else {
    before = memberBefore(model, indexes[0] ?? -1, frozen.diagnostics ?? []);
    const clone = JSON.parse(prepared.publicContent) as { limits: ModelLimit[] };
    if (indexes.length === 1) clone.limits = clone.limits.filter(limit => !isOrderValueLimit(limit, order));
    const others = decideCascade(documents, { ok: true, content: JSON.stringify(clone) }, null, {
      trustedAdapterIds: [ADAPTER_ID], diagnostics: true,
    }).checks.find(check => check.checkId === 'numeric_limits')?.status ?? 'not_verifiable';
    numericAfter = product.status === 'not_applicable' ? others : aggregate([others, product.status]);
  }
  const checks = frozen.checks.map(check => check.checkId === 'numeric_limits' ? { ...check, status: numericAfter } : check);
  const decision = finish(checks);
  const publicVerdict = applySharedHost(decision, prepared.grounding, documents);
  const blockers: { checkId: string; status: Status }[] = checks
    .filter(check => check.status === 'contradicted' || check.status === 'not_verifiable')
    .map(check => ({ checkId: check.checkId, status: check.status }));
  if (publicVerdict === 'UNCERTAIN' && decision === 'ALLOW') blockers.push({ checkId: 'grounding', status: 'not_verifiable' });
  return {
    version: ORDER_VALUE_PROTO_VERSION,
    frozenVerdict: frozen.decision,
    numericBefore,
    numericAfter,
    replaced: {
      checkId: 'numeric_limits',
      measureId: 'order_value',
      limitId: indexes.length === 1 ? model.limits[indexes[0]].id : null,
      before,
      after: product.status,
      reason: product.reason,
    },
    calculation: product.calculation,
    publicVerdict,
    blockers,
  };
}
