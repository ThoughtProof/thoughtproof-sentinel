import type { Document } from './contract.ts';

/**
 * One preflight case. It is not a holdout, not an acceptance case, and not
 * scored. The six fresh trade-order cases are not in this file.
 */
export const DUMMY_CASE_ID = 'DUMMY-PREFLIGHT-01';
export const DUMMY_MARK = 'DUMMY — not a holdout and not for evaluation';

export const DUMMY_ORDER = 'DUMMY ORDER: buy 3 units of SAMPLE-TICKET at 7 SAMPLE-COINS on the sample desk.';
export const DUMMY_MANDATE = 'DUMMY MANDATE: the sample desk may buy at most 3 units of SAMPLE-TICKET, and only after a written sample note says buy.';

export const DUMMY_EVIDENCE = [
  { id: 'sample-note', text: 'DUMMY NOTE: Buy SAMPLE-TICKET.' },
  { id: 'sample-ledger', text: 'DUMMY LEDGER: 0 units of SAMPLE-TICKET are on the sample book.' },
] as const;

/** Sentinel documents. The proposal is the order. Every other text is evidence or the mandate. */
export function dummyDocuments(): Document[] {
  return [
    { id: 'order', role: 'proposal', text: DUMMY_ORDER },
    { id: 'mandate', role: 'source', text: DUMMY_MANDATE },
    ...DUMMY_EVIDENCE.map(item => ({ id: item.id, role: 'source' as const, text: item.text })),
  ];
}

const evidenceItems = DUMMY_EVIDENCE.map(item => ({ id: item.id, text: item.text }));

/** Trade texts only. This is the historical request for the dummy order. */
export const DUMMY_CRITIC_CASE = { id: DUMMY_CASE_ID } as const;
export const DUMMY_CRITIC_ACTION = {
  mandate_text: DUMMY_MANDATE,
  proposed_action_text: DUMMY_ORDER,
  reasoning_text: DUMMY_EVIDENCE.map(item => item.text).join('\n'),
  evidence_items: evidenceItems,
} as const;

/**
 * Extra structured fields so gateway_strong returns execute true and the
 * critic branch is reached. They are not part of the trade-order request.
 */
export const DUMMY_GATEWAY_PROBE = {
  world: {
    sku_allowlist: ['DUMMY-SKU'],
    max_unit_eur: 10,
    max_qty: 1,
    max_total_eur: 10,
  },
  action: {
    kind: 'COMMIT',
    sku: 'DUMMY-SKU',
    unit_eur: 1,
    qty: 1,
    steps_done: [] as string[],
    evidence: [] as unknown[],
    ...DUMMY_CRITIC_ACTION,
  },
} as const;
