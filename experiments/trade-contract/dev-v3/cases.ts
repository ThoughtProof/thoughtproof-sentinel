import type { Document } from '../contract.ts';
import type { OrderCase } from '../dev-v2/cases.ts';
import { ORDER_CASES as V2_CASES } from '../dev-v2/cases.ts';

/** Next trade-order set. dev-v2 stays reachable and is not edited. */
export const DEV_V3_VERSION = 'dev-v3' as const;

/** Same text on every case. Independent of the order, the strategy, and the mandate. */
export const HOLDINGS_TEXT = 'Holdings before order placement: 40 Helio shares.';
export const HOLDINGS_QUOTE = '40 Helio shares';

export interface V3Case extends OrderCase {}

function holdings(): Document {
  return { id: 'holdings', role: 'source', text: HOLDINGS_TEXT };
}

/**
 * v2 documents, unchanged, plus the holdings source. New ids so the archived
 * ord-01..ord-06 run stays a different set.
 */
export const ORDER_CASES: readonly V3Case[] = V2_CASES.map((item, index) => ({
  caseId: `v3-0${index + 1}`,
  documents: [...item.documents, holdings()],
  precheck: item.precheck,
}));

export function orderCaseById(caseId: string): V3Case {
  const found = ORDER_CASES.find(item => item.caseId === caseId);
  if (!found) throw new Error('UNKNOWN_ORDER_CASE');
  return found;
}

/** Selector for `--trade-order-dev`. Schema smoke does not call this. */
export function tradeOrderCases(): readonly V3Case[] {
  return ORDER_CASES;
}
