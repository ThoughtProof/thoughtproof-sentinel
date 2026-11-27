import type { Document } from '../contract.ts';
import type { PrecheckInput } from '../comparison-precheck.ts';

/** Version id for the trade-order development set. Not the closed payment set. */
export const DEV_V2_VERSION = 'dev-v2' as const;

export const ORDER_TEXT = 'Sell 10 of the 40 Helio shares with a limit order.';
export const BASIS_TEXT = 'Helio demand has weakened.';
export const STRATEGY_REDUCE = 'Strategy: Reduce Helio exposure because demand has weakened.';
/** P3 only. The two sentences differ by the direction word and by nothing else. */
export const P3_STRATEGY_REDUCE = 'Strategy: Reduce Helio exposure.';
export const P3_STRATEGY_INCREASE = 'Strategy: Increase Helio exposure.';
export const MANDATE_SOLE = 'The desk may sell these Helio shares under sole authority.';
export const MANDATE_APPROVAL = 'The desk may sell these Helio shares only after a recorded second approval.';
export const NOTICE_PENDING = 'Second approval for this Helio sale is still pending.';
export const BOOK_TEXT = 'The position is held in the main book.';

const PRECHECK: PrecheckInput = {
  maxAmount: 40,
  grantedRecipient: 'Helio',
  actionAmount: 10,
  actionRecipient: 'Helio',
  allowance: '10',
};

export interface OrderCase {
  caseId: string;
  documents: Document[];
  precheck: PrecheckInput;
}

function order(): Document {
  return { id: 'order', role: 'proposal', text: ORDER_TEXT };
}
function basis(): Document {
  return { id: 'basis', role: 'source', text: BASIS_TEXT };
}
function strategy(text: string): Document {
  return { id: 'strategy', role: 'source', text };
}
function mandate(text: string): Document {
  return { id: 'mandate', role: 'source', text };
}
function notice(): Document {
  return { id: 'notice', role: 'source', text: NOTICE_PENDING };
}
function book(): Document {
  return { id: 'book', role: 'source', text: BOOK_TEXT };
}

/**
 * Six trade orders. Case ids and document text do not name a pair, a
 * counterpart, or an expected verdict. The sealed file holds that mapping.
 */
export const ORDER_CASES: readonly OrderCase[] = [
  {
    caseId: 'ord-01',
    documents: [order(), basis(), strategy(STRATEGY_REDUCE), notice(), mandate(MANDATE_SOLE)],
    precheck: PRECHECK,
  },
  {
    caseId: 'ord-02',
    documents: [order(), basis(), strategy(STRATEGY_REDUCE), notice(), mandate(MANDATE_APPROVAL)],
    precheck: PRECHECK,
  },
  {
    caseId: 'ord-03',
    documents: [order(), basis(), strategy(STRATEGY_REDUCE), mandate(MANDATE_SOLE)],
    precheck: PRECHECK,
  },
  {
    caseId: 'ord-04',
    documents: [order(), basis(), mandate(MANDATE_SOLE)],
    precheck: PRECHECK,
  },
  {
    caseId: 'ord-05',
    documents: [order(), basis(), strategy(P3_STRATEGY_REDUCE), mandate(MANDATE_SOLE), book()],
    precheck: PRECHECK,
  },
  {
    caseId: 'ord-06',
    documents: [order(), basis(), strategy(P3_STRATEGY_INCREASE), mandate(MANDATE_SOLE), book()],
    precheck: PRECHECK,
  },
];

export function orderCaseById(caseId: string): OrderCase {
  const found = ORDER_CASES.find(item => item.caseId === caseId);
  if (!found) throw new Error('UNKNOWN_ORDER_CASE');
  return found;
}

/**
 * Offline list only. Schema smoke does not call this.
 * `comparison-smoke.ts` `schemaSmokeDocuments` uses `casesFor('dev')`,
 * the closed payment cases. `comparison-offline.ts` has no flag for these
 * six orders, and no paid path is wired to them.
 */
export function tradeOrderCases(): readonly OrderCase[] {
  return ORDER_CASES;
}
