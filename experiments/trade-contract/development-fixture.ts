import { CHECK_IDS, CONTRACT_VERSION } from './contract.ts';
import type { Evidence, TradeContractInput } from './contract.ts';
import { documentDigest } from './evaluate.ts';

export const DEVELOPMENT_ADAPTER = 'invented-development-fixture';

/** Entirely invented development case, not evaluation data or a model prediction. */
export function developmentFixture(): TradeContractInput {
  const documents: TradeContractInput['documents'] = [
    {
      id: 'context', role: 'source',
      text: 'Strategy: Reduce Helio exposure because demand has weakened.\n'
        + 'Mandate: Do not create a short position.\n'
        + 'Maximum intended risk: <= 0.30 % of decision-time account equity.\n',
    },
    {
      id: 'order', role: 'proposal',
      text: 'Verkaufe 10 der vorhandenen 40 Helio-Aktien mit einer Limitorder.\n'
        + 'Geplantes Risiko: 0.20 % des Kontoeigenkapitals zum Entscheidungszeitpunkt.\n',
    },
  ];
  const quote = (documentId: string, quote: string): Evidence => {
    const start = documents.find(document => document.id === documentId)!.text.indexOf(quote);
    if (start < 0) throw new Error('Invalid invented fixture');
    return { documentId, start, end: start + quote.length, quote };
  };
  const strategy = quote('context', 'Strategy: Reduce Helio exposure because demand has weakened.');
  const mandate = quote('context', 'Mandate: Do not create a short position.');
  const order = quote('order', 'Verkaufe 10 der vorhandenen 40 Helio-Aktien mit einer Limitorder.');
  const risk = quote('order', 'Geplantes Risiko: 0.20 % des Kontoeigenkapitals zum Entscheidungszeitpunkt.');
  const bound = quote('context', 'Maximum intended risk: <= 0.30 % of decision-time account equity.');
  const orderReference = quote('order', 'des Kontoeigenkapitals zum Entscheidungszeitpunkt');
  const limitReference = quote('context', 'of decision-time account equity');
  const binding = {
    subjectId: 'proposed-order', measureId: 'intended-risk', unit: 'percent', referenceId: 'decision-time-account-equity',
  };
  return {
    version: CONTRACT_VERSION,
    documents,
    adapter: {
      id: DEVELOPMENT_ADAPTER, contractVersion: CONTRACT_VERSION, complete: true,
      coverage: documents.map(document => ({ documentId: document.id, sha256: documentDigest(document.text) })),
    },
    applicability: CHECK_IDS.map(checkId => ({
      checkId,
      status: checkId === 'additional_claims' ? 'not_applicable' : 'applicable',
      basis: checkId === 'additional_claims' ? 'none_in_complete_scope'
        : checkId === 'decision_basis' || checkId === 'order_strategy_consistency' ? 'mandatory' : 'explicit_items',
      documentIds: documents.map(document => document.id), complete: true,
    })),
    requirements: [
      { id: 'reduce-exposure', kind: 'strategy', evidence: [strategy] },
      { id: 'no-short', kind: 'mandate', evidence: [mandate] },
    ],
    semanticChecks: [
      { checkId: 'decision_basis', status: 'fulfilled', evidence: [order, strategy], requirementIds: [] },
      { checkId: 'order_strategy_consistency', status: 'fulfilled', evidence: [order, strategy], requirementIds: ['reduce-exposure'] },
      { checkId: 'mandate_compliance', status: 'fulfilled', evidence: [order, mandate], requirementIds: ['no-short'] },
    ],
    claims: [],
    quantities: [{
      id: 'order-risk', binding: { ...binding }, value: '0.20', valueEvidence: quote('order', '0.20'),
      bindingEvidence: [risk], referenceEvidence: orderReference,
    }],
    limits: [{
      id: 'risk-cap', binding: { ...binding }, operator: '<=', value: '0.30', valueEvidence: quote('context', '0.30'),
      bindingEvidence: [bound], referenceEvidence: limitReference, quantityId: 'order-risk',
    }],
  };
}
