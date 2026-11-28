import type { OrderLabel } from '../dev-v2/labels.ts';

/**
 * Sealed before any model run. The case module and the request builder do
 * not import this file.
 */
export const ORDER_LABELS: readonly OrderLabel[] = [
  {
    caseId: 'v3-01',
    pairId: 'P1',
    variedFact: 'mandate grants sole authority',
    expected: 'ALLOW',
    decisiveCheckId: 'mandate_compliance',
    decisiveStatus: 'fulfilled',
  },
  {
    caseId: 'v3-02',
    pairId: 'P1',
    variedFact: 'mandate requires the pending approval before execution',
    expected: 'BLOCK',
    decisiveCheckId: 'mandate_compliance',
    decisiveStatus: 'contradicted',
  },
  {
    caseId: 'v3-03',
    pairId: 'P2',
    variedFact: 'governing strategy source is present',
    expected: 'ALLOW',
    decisiveCheckId: 'order_strategy_consistency',
    decisiveStatus: 'fulfilled',
  },
  {
    caseId: 'v3-04',
    pairId: 'P2',
    variedFact: 'governing strategy source is absent',
    expected: 'UNCERTAIN',
    decisiveCheckId: 'order_strategy_consistency',
    decisiveStatus: 'not_verifiable',
  },
  {
    caseId: 'v3-05',
    pairId: 'P3',
    variedFact: 'direction word Reduce',
    expected: 'ALLOW',
    decisiveCheckId: 'order_strategy_consistency',
    decisiveStatus: 'fulfilled',
  },
  {
    caseId: 'v3-06',
    pairId: 'P3',
    variedFact: 'direction word Increase',
    expected: 'BLOCK',
    decisiveCheckId: 'order_strategy_consistency',
    decisiveStatus: 'contradicted',
  },
];
