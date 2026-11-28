import { orderReference as v2Reference } from '../dev-v2/reference.ts';
import { HOLDINGS_QUOTE, ORDER_CASES, orderCaseById } from './cases.ts';

const V2_ID = ['ord-01', 'ord-02', 'ord-03', 'ord-04', 'ord-05', 'ord-06'] as const;

function v2Id(caseId: string): (typeof V2_ID)[number] {
  const index = ORDER_CASES.findIndex(item => item.caseId === caseId);
  const id = V2_ID[index];
  if (!id) throw new Error('UNKNOWN_ORDER_CASE');
  return id;
}

interface Model {
  applicability: { checkId: string; status: string; basis: string; documentIds: string[] }[];
  detection: { checkId: string; result: string }[];
  claims: unknown[];
}

/** v2 reference, plus a fulfilled holdings fact. `claims` is never empty. */
export function orderReference(caseId: string): string {
  orderCaseById(caseId);
  const model = JSON.parse(v2Reference(v2Id(caseId))) as Model;
  for (const row of model.applicability) row.documentIds = [...row.documentIds, 'holdings'];
  const claimsRow = model.applicability.find(row => row.checkId === 'additional_claims');
  if (!claimsRow) throw new Error('CLAIMS_APPLICABILITY');
  claimsRow.status = 'applicable';
  claimsRow.basis = 'explicit_items';
  const detection = model.detection.find(row => row.checkId === 'additional_claims');
  if (!detection) throw new Error('CLAIMS_DETECTION');
  detection.result = 'found';
  model.claims = [{
    id: 'held-helio',
    kind: 'source_fact',
    status: 'fulfilled',
    claimQuote: { documentId: 'order', quote: HOLDINGS_QUOTE },
    supportingQuotes: [{ documentId: 'holdings', quote: HOLDINGS_QUOTE }],
    calculation: null,
  }];
  return JSON.stringify(model);
}
