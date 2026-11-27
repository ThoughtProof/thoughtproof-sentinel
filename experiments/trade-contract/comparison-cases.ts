import type { Document } from './contract.ts';
import type { PrecheckInput } from './comparison-precheck.ts';

export type CaseSplit = 'pilot' | 'dev';

/**
 * Case inputs only. No expected verdict, pair id, counterpart id, or rationale.
 * The prompt builder receives `documents` and nothing else on this object.
 */
export interface ComparisonCase {
  caseId: string;
  split: CaseSplit;
  documents: Document[];
  precheck: PrecheckInput;
}

function documents(
  proposal: string,
  mandate: string,
  source: { id: string; text: string } | null,
): Document[] {
  const rows: Document[] = [{ id: 'proposal', role: 'proposal', text: proposal }];
  if (source) rows.push({ id: source.id, role: 'source', text: source.text });
  rows.push({ id: 'mandate', role: 'source', text: mandate });
  return rows;
}

const PILOT_01_PROPOSAL = 'Pay 250 EUR to Northwind for invoice INV-100.';
const PILOT_01_INVOICE = 'Invoice INV-100 from Northwind for 250 EUR. Goods received. Second approval for INV-100 is pending.';
const PILOT_01_MANDATE = 'The treasurer may pay invoice INV-100 up to 500 EUR to Northwind. No second approval is required.';
const PILOT_02_MANDATE = 'The treasurer may pay invoice INV-100 up to 500 EUR to Northwind only after a recorded second approval.';

const PILOT_03_PROPOSAL = 'Pay 100 EUR to Contoso for invoice INV-200.';
const PILOT_03_INVOICE = 'Invoice INV-200 from Contoso for 100 EUR.';
const PILOT_03_MANDATE = 'The treasurer may pay 100 EUR to Contoso for invoice INV-200 only when the invoice is attached.';

const PILOT_05_PROPOSAL = 'Pay 80 EUR to Fabrikam for shipping invoice SH-9.';
const PILOT_05_INVOICE = 'Shipping invoice SH-9 from Fabrikam for 80 EUR.';
const PILOT_06_INVOICE = 'Shipping invoice SH-10 from Fabrikam for 80 EUR.';
const PILOT_05_MANDATE = 'The treasurer may pay 80 EUR to Fabrikam for shipping invoice SH-9.';

const DEV_01_PROPOSAL = 'Settle 40 EUR to Alpine Paper for bill BILL-9.';
const DEV_01_BILL = 'Bill BILL-9 from Alpine Paper for 40 EUR. The board minute is not on file.';
const DEV_01_MANDATE = 'The clerk may settle bill BILL-9 for 40 EUR to Alpine Paper. The clerk acts alone.';
const DEV_02_MANDATE = 'The clerk may settle bill BILL-9 for 40 EUR to Alpine Paper only after the board minute is on file.';

const DEV_03_PROPOSAL = 'Settle 15 EUR to Birch Supply for bill BILL-3.';
const DEV_03_RECEIPT = 'Delivery receipt for bill BILL-3 from Birch Supply.';
const DEV_03_MANDATE = 'The clerk may settle 15 EUR to Birch Supply for bill BILL-3 only when the delivery receipt is attached.';

export const COMPARISON_CASES: readonly ComparisonCase[] = [
  {
    caseId: 'pilot-01',
    split: 'pilot',
    documents: documents(PILOT_01_PROPOSAL, PILOT_01_MANDATE, { id: 'invoice', text: PILOT_01_INVOICE }),
    precheck: { maxAmount: 500, grantedRecipient: 'Northwind', actionAmount: 250, actionRecipient: 'Northwind', allowance: '250' },
  },
  {
    caseId: 'pilot-02',
    split: 'pilot',
    documents: documents(PILOT_01_PROPOSAL, PILOT_02_MANDATE, { id: 'invoice', text: PILOT_01_INVOICE }),
    precheck: { maxAmount: 500, grantedRecipient: 'Northwind', actionAmount: 250, actionRecipient: 'Northwind', allowance: '250' },
  },
  {
    caseId: 'pilot-03',
    split: 'pilot',
    documents: documents(PILOT_03_PROPOSAL, PILOT_03_MANDATE, { id: 'invoice', text: PILOT_03_INVOICE }),
    precheck: { maxAmount: 500, grantedRecipient: 'Contoso', actionAmount: 100, actionRecipient: 'Contoso', allowance: '100' },
  },
  {
    caseId: 'pilot-04',
    split: 'pilot',
    documents: documents(PILOT_03_PROPOSAL, PILOT_03_MANDATE, null),
    precheck: { maxAmount: 500, grantedRecipient: 'Contoso', actionAmount: 100, actionRecipient: 'Contoso', allowance: '100' },
  },
  {
    caseId: 'pilot-05',
    split: 'pilot',
    documents: documents(PILOT_05_PROPOSAL, PILOT_05_MANDATE, { id: 'invoice', text: PILOT_05_INVOICE }),
    precheck: { maxAmount: 500, grantedRecipient: 'Fabrikam', actionAmount: 80, actionRecipient: 'Fabrikam', allowance: '80' },
  },
  {
    caseId: 'pilot-06',
    split: 'pilot',
    documents: documents(PILOT_05_PROPOSAL, PILOT_05_MANDATE, { id: 'invoice', text: PILOT_06_INVOICE }),
    precheck: { maxAmount: 500, grantedRecipient: 'Fabrikam', actionAmount: 80, actionRecipient: 'Fabrikam', allowance: '80' },
  },
  {
    caseId: 'dev-01',
    split: 'dev',
    documents: documents(DEV_01_PROPOSAL, DEV_01_MANDATE, { id: 'bill', text: DEV_01_BILL }),
    precheck: { maxAmount: 100, grantedRecipient: 'Alpine Paper', actionAmount: 40, actionRecipient: 'Alpine Paper', allowance: '40' },
  },
  {
    caseId: 'dev-02',
    split: 'dev',
    documents: documents(DEV_01_PROPOSAL, DEV_02_MANDATE, { id: 'bill', text: DEV_01_BILL }),
    precheck: { maxAmount: 100, grantedRecipient: 'Alpine Paper', actionAmount: 40, actionRecipient: 'Alpine Paper', allowance: '40' },
  },
  {
    caseId: 'dev-03',
    split: 'dev',
    documents: documents(DEV_03_PROPOSAL, DEV_03_MANDATE, { id: 'receipt', text: DEV_03_RECEIPT }),
    precheck: { maxAmount: 100, grantedRecipient: 'Birch Supply', actionAmount: 15, actionRecipient: 'Birch Supply', allowance: '15' },
  },
  {
    caseId: 'dev-04',
    split: 'dev',
    documents: documents(DEV_03_PROPOSAL, DEV_03_MANDATE, null),
    precheck: { maxAmount: 100, grantedRecipient: 'Birch Supply', actionAmount: 15, actionRecipient: 'Birch Supply', allowance: '15' },
  },
];

export function casesFor(split: CaseSplit): ComparisonCase[] {
  return COMPARISON_CASES.filter(item => item.split === split);
}

export function caseById(caseId: string): ComparisonCase {
  const found = COMPARISON_CASES.find(item => item.caseId === caseId);
  if (!found) throw new Error('UNKNOWN_CASE');
  return found;
}
