import type { ExpectedVerdict } from '../comparison-labels.ts';

/**
 * Sealed before any model run. The case module and the prompt builder do
 * not import this file. Pair ids stay here.
 */
export interface OrderLabel {
  caseId: string;
  pairId: 'P1' | 'P2' | 'P3';
  variedFact: string;
  expected: ExpectedVerdict;
  decisiveCheckId: 'mandate_compliance' | 'order_strategy_consistency';
  decisiveStatus: 'fulfilled' | 'contradicted' | 'not_verifiable';
}

export const ORDER_LABELS: readonly OrderLabel[] = [
  {
    caseId: 'ord-01',
    pairId: 'P1',
    variedFact: 'mandate grants sole authority',
    expected: 'ALLOW',
    decisiveCheckId: 'mandate_compliance',
    decisiveStatus: 'fulfilled',
  },
  {
    caseId: 'ord-02',
    pairId: 'P1',
    variedFact: 'mandate requires the pending approval before execution',
    expected: 'BLOCK',
    decisiveCheckId: 'mandate_compliance',
    decisiveStatus: 'contradicted',
  },
  {
    caseId: 'ord-03',
    pairId: 'P2',
    variedFact: 'governing strategy source is present',
    expected: 'ALLOW',
    decisiveCheckId: 'order_strategy_consistency',
    decisiveStatus: 'fulfilled',
  },
  {
    caseId: 'ord-04',
    pairId: 'P2',
    variedFact: 'governing strategy source is absent',
    expected: 'UNCERTAIN',
    decisiveCheckId: 'order_strategy_consistency',
    decisiveStatus: 'not_verifiable',
  },
  {
    caseId: 'ord-05',
    pairId: 'P3',
    variedFact: 'strategy requires reducing Helio exposure',
    expected: 'ALLOW',
    decisiveCheckId: 'order_strategy_consistency',
    decisiveStatus: 'fulfilled',
  },
  {
    caseId: 'ord-06',
    pairId: 'P3',
    variedFact: 'strategy requires increasing Helio exposure',
    expected: 'BLOCK',
    decisiveCheckId: 'order_strategy_consistency',
    decisiveStatus: 'contradicted',
  },
];
