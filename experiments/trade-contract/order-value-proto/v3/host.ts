import { ADAPTER_ID, decideCascade } from '../../adapter.ts';
import { prepareModelContent, quoteBlocksRelease, type GroundingRow } from '../../comparison-grounding.ts';
import type { Decision, Document, Status } from '../../contract.ts';
import { compareDecimal, readNumericToken } from '../../decimal.ts';
import { uniqueQuoteSpan } from '../../spans.ts';
import { multiplyDecimal } from './decimal-mul.ts';

/**
 * order-value-proto/v3. Two toggles. The frozen evaluator and
 * comparison-grounding.ts are not edited.
 *
 * Change 1 (clauseBinding). Every host proof is one authorized clause.
 * A proof counts only when clause id, order reference, instrument, unit,
 * operator and limit value all match that clause. The clause is enforced
 * even when the extractor omitted it. Two clauses may share a number and
 * differ in operator; both stay in force.
 *
 * Change 2 (quantityGrounding). After quoteBlocksRelease, this layer may
 * clear exactly one row: its clause is the authorized quantity cap, and its
 * evidence is the host-bound quantity of this order, and that comparison
 * passed. A price quote with "per share", another order, a bare met
 * reading, and every open or violated row stay blocking.
 */
export const ORDER_VALUE_PROTO_VERSION = 'order-value-proto/v3' as const;

export type Operator = '<' | '<=' | '>' | '>=' | '==';

export interface AuthorizedClause {
  clauseId: string;
  orderRef: string;
  instrument: string;
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

export interface V3Toggles {
  clauseBinding: boolean;
  quantityGrounding: boolean;
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

export interface GroundingNote {
  index: number;
  blocks: boolean;
  reason: string;
  clauseId: string | null;
}

export interface PublicComposition {
  version: typeof ORDER_VALUE_PROTO_VERSION;
  toggles: V3Toggles;
  frozenVerdict: Decision;
  numericBefore: Status;
  numericAfter: Status;
  proofs: ClauseProof[];
  grounding: GroundingNote[];
  publicVerdict: Decision;
  blockers: { checkId: string; status: Status }[];
}

export function proofMatchesClause(proof: ClauseProof, item: AuthorizedClause): boolean {
  return proof.clauseId === item.clauseId
    && proof.orderRef === item.orderRef
    && proof.instrument === item.instrument
    && proof.unit === item.unit
    && proof.operator === item.operator
    && proof.limitValue === item.limitValue;
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

function provenSource(documents: readonly Document[], source: { documentId: string; quote: string }, value: string): boolean {
  const document = documents.find(item => item.id === source.documentId);
  if (!document || document.role !== 'source') return false;
  return uniqueQuoteSpan(document.text, source.quote) !== null && quoteCarries(source.quote, value);
}

function provenProposal(documents: readonly Document[], order: OrderUnderReview, field: { value: string; quote: string }): boolean {
  const document = documents.find(item => item.id === order.proposalDocumentId);
  if (!document || document.role !== 'proposal') return false;
  return uniqueQuoteSpan(document.text, field.quote) !== null && quoteCarries(field.quote, field.value);
}

function applyOperator(operand: string, limit: string, operator: Operator): Status | null {
  const comparison = compareDecimal(operand, limit);
  if (comparison === null) return null;
  const ok = operator === '<' ? comparison < 0
    : operator === '<=' ? comparison <= 0
      : operator === '>' ? comparison > 0
        : operator === '>=' ? comparison >= 0 : comparison === 0;
  return ok ? 'fulfilled' : 'contradicted';
}

function evaluateClause(documents: readonly Document[], order: OrderUnderReview, item: AuthorizedClause): ClauseProof {
  const proof: ClauseProof = {
    clauseId: item.clauseId, orderRef: item.orderRef, instrument: item.instrument,
    unit: item.unit, operator: item.operator, limitValue: item.limitValue,
    status: 'not_verifiable', reason: 'unbound', operand: null,
  };
  if (!proofMatchesClause(proof, item)) return { ...proof, reason: 'identity_mismatch' };
  if (item.orderRef !== order.orderRef || item.instrument !== order.instrument) {
    return { ...proof, status: 'not_applicable', reason: 'other_order' };
  }
  if (!provenSource(documents, item.source, item.limitValue)) return { ...proof, reason: 'clause_unproven' };
  if (!provenProposal(documents, order, order.quantity)) return { ...proof, reason: 'quantity_unproven' };
  if (item.kind === 'quantity') {
    if (item.unit !== 'shares') return { ...proof, reason: 'unit_mismatch' };
    const token = readNumericToken(order.quantity.value);
    if (token.status !== 'exact') return { ...proof, reason: 'token_not_exact' };
    const status = applyOperator(token.canonical, item.limitValue, item.operator);
    if (!status) return { ...proof, reason: 'comparison_not_exact' };
    return { ...proof, status, reason: status === 'fulfilled' ? 'quantity_within_cap' : 'quantity_outside_cap', operand: token.canonical };
  }
  if (item.unit !== order.currency) return { ...proof, reason: 'unit_mismatch' };
  if (!provenProposal(documents, order, order.limitPrice)) return { ...proof, reason: 'price_unproven' };
  const shares = readNumericToken(order.quantity.value);
  const price = readNumericToken(order.limitPrice.value);
  const cap = readNumericToken(item.limitValue);
  if (shares.status !== 'exact' || price.status !== 'exact' || cap.status !== 'exact') return { ...proof, reason: 'token_not_exact' };
  const product = multiplyDecimal(shares.canonical, price.canonical);
  if (!product) return { ...proof, reason: 'product_not_exact' };
  const status = applyOperator(product, cap.canonical, item.operator);
  if (!status) return { ...proof, reason: 'comparison_not_exact' };
  return { ...proof, status, reason: status === 'fulfilled' ? 'order_value_within_cap' : 'order_value_outside_cap', operand: product };
}

interface ModelLimit {
  binding: { subjectId: string; unit: string };
  operator: Operator;
  value: string;
}

function limitIsClause(limit: ModelLimit, item: AuthorizedClause): boolean {
  return limit.binding.subjectId === item.instrument
    && limit.binding.unit === item.unit
    && limit.operator === item.operator
    && compareDecimal(limit.value, item.limitValue) === 0;
}

/** Price evidence is not quantity evidence. The operand quote itself may mention per share. */
function evidenceProvesQuantity(quote: string | null, order: OrderUnderReview): boolean {
  if (!quote || !quote.includes(order.quantity.quote) || !quoteCarries(order.quantity.quote, order.quantity.value)) return false;
  if (/per share/i.test(quote) && quote !== order.quantity.quote && !quote.includes(order.quantity.quote)) return false;
  return true;
}

function groundingRow(
  row: GroundingRow,
  documents: readonly Document[],
  mandate: MandatePacket,
  order: OrderUnderReview,
  proofs: readonly ClauseProof[],
  toggles: V3Toggles,
): { blocks: boolean; reason: string; clauseId: string | null } {
  const frozen = quoteBlocksRelease(row, documents);
  if (row.reading === 'open' || row.reading === 'violated') return { blocks: true, reason: 'reading_open_or_violated', clauseId: null };
  if (!toggles.quantityGrounding) return { blocks: frozen, reason: 'frozen_heuristic', clauseId: null };
  const passed = proofs.filter(proof => proof.status === 'fulfilled' && proof.unit === 'shares'
    && proof.orderRef === order.orderRef && proof.instrument === order.instrument
    && mandate.clauses.some(item => item.kind === 'quantity' && proofMatchesClause(proof, item)
      && row.clauseDocumentId === item.source.documentId && row.clauseQuote === item.source.quote));
  if (passed.length !== 1) return { blocks: frozen, reason: passed.length === 0 ? 'not_the_quantity_clause' : 'quantity_clause_not_unique', clauseId: null };
  if (row.evidenceDocumentId !== order.proposalDocumentId) return { blocks: true, reason: 'other_order', clauseId: passed[0].clauseId };
  if (/per share/i.test(row.evidenceQuote ?? '') && !(row.evidenceQuote ?? '').includes(order.quantity.quote)) {
    return { blocks: true, reason: 'price_evidence', clauseId: passed[0].clauseId };
  }
  if (!evidenceProvesQuantity(row.evidenceQuote, order)) return { blocks: frozen, reason: 'evidence_not_quantity', clauseId: passed[0].clauseId };
  return {
    blocks: false,
    reason: `quantity_comparison_passed:${passed[0].clauseId}:${passed[0].operand} ${passed[0].operator} ${passed[0].limitValue}`,
    clauseId: passed[0].clauseId,
  };
}

export function composePublic(
  documents: readonly Document[],
  content: string,
  mandate: MandatePacket,
  order: OrderUnderReview,
  toggles: V3Toggles,
): PublicComposition {
  const prepared = prepareModelContent(content, documents, 'primary');
  const frozen = decideCascade(documents, { ok: true, content: prepared.publicContent }, null, {
    trustedAdapterIds: [ADAPTER_ID], diagnostics: true,
  });
  const proofs = mandate.clauses.map(item => evaluateClause(documents, order, item));
  const numericBefore = frozen.checks.find(check => check.checkId === 'numeric_limits')?.status ?? 'not_verifiable';
  let numericAfter = numericBefore;
  if (toggles.clauseBinding) {
    const model = JSON.parse(prepared.publicContent) as { limits: ModelLimit[] };
    const covered = mandate.clauses.filter(item => item.orderRef === order.orderRef && item.instrument === order.instrument);
    model.limits = model.limits.filter(limit => !covered.some(item => limitIsClause(limit, item)));
    const others = decideCascade(documents, { ok: true, content: JSON.stringify(model) }, null, {
      trustedAdapterIds: [ADAPTER_ID],
    }).checks.find(check => check.checkId === 'numeric_limits')?.status ?? 'not_verifiable';
    const host = proofs.filter(proof => proof.status !== 'not_applicable').map(proof => proof.status);
    numericAfter = aggregate([others, ...host]);
  }
  const checks = frozen.checks.map(check => check.checkId === 'numeric_limits' ? { ...check, status: numericAfter } : check);
  const decision = finish(checks);
  const grounding = prepared.grounding.map((row, index) => {
    const note = groundingRow(row, documents, mandate, order, proofs, toggles);
    return { index, ...note };
  });
  const blocked = decision === 'ALLOW' && grounding.some(note => note.blocks);
  const publicVerdict: Decision = blocked ? 'UNCERTAIN' : decision;
  const blockers: { checkId: string; status: Status }[] = checks
    .filter(check => check.status === 'contradicted' || check.status === 'not_verifiable')
    .map(check => ({ checkId: check.checkId, status: check.status }));
  if (blocked) blockers.push({ checkId: 'grounding', status: 'not_verifiable' });
  return {
    version: ORDER_VALUE_PROTO_VERSION,
    toggles, frozenVerdict: frozen.decision, numericBefore, numericAfter, proofs, grounding, publicVerdict, blockers,
  };
}
