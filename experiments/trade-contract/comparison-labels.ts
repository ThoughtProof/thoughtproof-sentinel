import type { CaseSplit } from './comparison-cases.ts';

export type ExpectedVerdict = 'ALLOW' | 'BLOCK' | 'UNCERTAIN';

/**
 * Sealed labels. Written before any arm comparison. The prompt builder and
 * the case-input module do not import this file. Rationale strings start
 * with SEALED: so a payload test can see a leak.
 */
export interface SealedLabel {
  caseId: string;
  split: CaseSplit;
  expected: ExpectedVerdict;
  justified: boolean;
  rationale: string;
}

export const SEALED_LABELS: readonly SealedLabel[] = [
  {
    caseId: 'pilot-01',
    split: 'pilot',
    expected: 'ALLOW',
    justified: true,
    rationale: 'SEALED: Sole authority covers this payment, the invoice is present, and a pending second approval is not a condition of this mandate.',
  },
  {
    caseId: 'pilot-02',
    split: 'pilot',
    expected: 'BLOCK',
    justified: false,
    rationale: 'SEALED: This mandate withholds the same payment until a second approval, and the shared status says that approval is still pending.',
  },
  {
    caseId: 'pilot-03',
    split: 'pilot',
    expected: 'ALLOW',
    justified: true,
    rationale: 'SEALED: The mandate requires the invoice document, and that document is present.',
  },
  {
    caseId: 'pilot-04',
    split: 'pilot',
    expected: 'UNCERTAIN',
    justified: false,
    rationale: 'SEALED: The mandate requires the invoice document, and that document is absent, so the condition is open.',
  },
  {
    caseId: 'pilot-05',
    split: 'pilot',
    expected: 'ALLOW',
    justified: true,
    rationale: 'SEALED: The shipping invoice identifier matches the identifier named by the mandate.',
  },
  {
    caseId: 'pilot-06',
    split: 'pilot',
    expected: 'BLOCK',
    justified: false,
    rationale: 'SEALED: The shipping invoice identifier does not match the identifier named by the mandate.',
  },
  {
    caseId: 'dev-01',
    split: 'dev',
    expected: 'ALLOW',
    justified: true,
    rationale: 'SEALED: The clerk is the sole actor for this bill, so a missing board minute is not a binding condition.',
  },
  {
    caseId: 'dev-02',
    split: 'dev',
    expected: 'BLOCK',
    justified: false,
    rationale: 'SEALED: The mandate withholds settlement until the board minute is on file, and the bill says it is not.',
  },
  {
    caseId: 'dev-03',
    split: 'dev',
    expected: 'ALLOW',
    justified: true,
    rationale: 'SEALED: The mandate requires the delivery receipt, and that receipt is present.',
  },
  {
    caseId: 'dev-04',
    split: 'dev',
    expected: 'UNCERTAIN',
    justified: false,
    rationale: 'SEALED: The mandate requires the delivery receipt, and that receipt is absent, so the condition is open.',
  },
];

export function labelsFor(split: CaseSplit): SealedLabel[] {
  return SEALED_LABELS.filter(item => item.split === split);
}
