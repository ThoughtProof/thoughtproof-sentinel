import { caseById, casesFor } from './comparison-cases.ts';
import type { GroundingRow } from './comparison-grounding.ts';
import { labelsFor, type ExpectedVerdict } from './comparison-labels.ts';
import { mechanicalOutput } from './comparison-mechanical.ts';
import type { ComparisonArm } from './comparison-prompt.ts';
import { assessModelText } from './comparison-report.ts';

/**
 * Hand-built answers. Each quote is an exact span of that development case.
 * These are not model outputs and they do not change pilot cases.
 */
const IDEAL: Record<string, {
  proposal: string;
  source: string;
  mandate: string;
  extra?: { id: string; documentId: string; quote: string };
  mandateStatus: 'fulfilled' | 'contradicted' | 'not_verifiable';
  reading: GroundingRow['reading'];
  evidenceDocumentId: string | null;
  evidenceQuote: string | null;
}> = {
  'dev-01': {
    proposal: 'Settle 40 EUR to Alpine Paper for bill BILL-9.',
    source: 'Bill BILL-9 from Alpine Paper for 40 EUR.',
    mandate: 'The clerk may settle bill BILL-9 for 40 EUR to Alpine Paper. The clerk acts alone.',
    mandateStatus: 'fulfilled',
    reading: 'met',
    evidenceDocumentId: 'bill',
    evidenceQuote: 'Bill BILL-9 from Alpine Paper for 40 EUR.',
  },
  'dev-02': {
    proposal: 'Settle 40 EUR to Alpine Paper for bill BILL-9.',
    source: 'Bill BILL-9 from Alpine Paper for 40 EUR.',
    mandate: 'The clerk may settle bill BILL-9 for 40 EUR to Alpine Paper only after the board minute is on file.',
    extra: { id: 'board-minute', documentId: 'bill', quote: 'The board minute is not on file.' },
    mandateStatus: 'contradicted',
    reading: 'violated',
    evidenceDocumentId: 'bill',
    evidenceQuote: 'The board minute is not on file.',
  },
  'dev-03': {
    proposal: 'Settle 15 EUR to Birch Supply for bill BILL-3.',
    source: 'Delivery receipt for bill BILL-3 from Birch Supply.',
    mandate: 'The clerk may settle 15 EUR to Birch Supply for bill BILL-3 only when the delivery receipt is attached.',
    mandateStatus: 'fulfilled',
    reading: 'met',
    evidenceDocumentId: 'receipt',
    evidenceQuote: 'Delivery receipt for bill BILL-3 from Birch Supply.',
  },
  'dev-04': {
    proposal: 'Settle 15 EUR to Birch Supply for bill BILL-3.',
    source: 'The clerk may settle 15 EUR to Birch Supply for bill BILL-3 only when the delivery receipt is attached.',
    mandate: 'The clerk may settle 15 EUR to Birch Supply for bill BILL-3 only when the delivery receipt is attached.',
    mandateStatus: 'not_verifiable',
    reading: 'open',
    evidenceDocumentId: null,
    evidenceQuote: null,
  },
  'dev-05': {
    proposal: 'Pay 250 EUR to Harbor Co for invoice INV-440.',
    source: 'Invoice INV-440 from Harbor Co for 250 EUR.',
    mandate: 'The treasurer may pay invoice INV-440 up to 500 EUR to Harbor Co only after a recorded second approval.',
    extra: { id: 'second-approval', documentId: 'invoice', quote: 'Second approval for INV-440 is still pending.' },
    mandateStatus: 'contradicted',
    reading: 'violated',
    evidenceDocumentId: 'invoice',
    evidenceQuote: 'Second approval for INV-440 is still pending.',
  },
  'dev-06': {
    proposal: 'Pay 250 EUR to Harbor Co for invoice INV-440.',
    source: 'Invoice INV-440 from Harbor Co for 250 EUR.',
    mandate: 'The treasurer may pay invoice INV-440 up to 500 EUR to Harbor Co. A second approval is not required.',
    mandateStatus: 'fulfilled',
    reading: 'met',
    evidenceDocumentId: 'invoice',
    evidenceQuote: 'Invoice INV-440 from Harbor Co for 250 EUR.',
  },
};

export function idealModelAnswer(caseId: string): string {
  const spec = IDEAL[caseId];
  const item = caseById(caseId);
  if (!spec) throw new Error('NO_IDEAL');
  return mechanicalOutput({
    documents: item.documents,
    proposalQuote: spec.proposal,
    sourceQuote: spec.source,
    mandateQuote: spec.mandate,
    extra: spec.extra,
    mandateStatus: spec.mandateStatus,
    grounding: [{
      objectionId: 'stated-mandate',
      clauseDocumentId: 'mandate',
      clauseQuote: spec.mandate,
      evidenceDocumentId: spec.evidenceDocumentId,
      evidenceQuote: spec.evidenceQuote,
      reading: spec.reading,
    }],
  });
}

export interface IdealReachability {
  caseId: string;
  arm: ComparisonArm;
  expected: ExpectedVerdict;
  parserResult: string;
  frozenGateVerdict: string | null;
  publicVerdict: string | null;
  reachedExpected: boolean;
}

/** Both arms see the same ideal JSON. The host path does not branch on arm. */
export function idealDevReachability(): IdealReachability[] {
  const labels = new Map(labelsFor('dev').map(label => [label.caseId, label.expected]));
  const rows: IdealReachability[] = [];
  for (const item of casesFor('dev')) {
    const content = idealModelAnswer(item.caseId);
    const expected = labels.get(item.caseId);
    if (!expected) throw new Error('NO_LABEL');
    for (const arm of ['A', 'B'] as const) {
      const assessed = assessModelText(item.documents, content);
      rows.push({
        caseId: item.caseId,
        arm,
        expected,
        parserResult: assessed.parserResult,
        frozenGateVerdict: assessed.frozenGateVerdict,
        publicVerdict: assessed.publicVerdict,
        reachedExpected: assessed.parserResult === 'ok' && assessed.publicVerdict === expected,
      });
    }
  }
  return rows;
}
