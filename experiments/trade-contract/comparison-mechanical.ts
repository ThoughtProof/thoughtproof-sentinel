import { ADAPTER_OUTPUT_VERSION } from './adapter.ts';
import type { Document } from './contract.ts';
import type { GroundingRow } from './comparison-grounding.ts';

/**
 * Hand-built adapter JSON for offline tests. These are not model outputs
 * and they are not acceptance recordings.
 */
export interface MechanicalSpec {
  documents: readonly Document[];
  proposalQuote: string;
  sourceQuote: string;
  mandateQuote: string;
  extra?: { id: string; documentId: string; quote: string };
  mandateStatus: 'fulfilled' | 'contradicted';
  complete?: boolean;
  grounding: GroundingRow[] | null;
}

function quote(documentId: string, text: string): { documentId: string; quote: string } {
  return { documentId, quote: text };
}

export function mechanicalOutput(spec: MechanicalSpec): string {
  const documentIds = spec.documents.map(document => document.id);
  const proposalId = spec.documents.find(document => document.role === 'proposal')?.id;
  if (!proposalId) throw new Error('MECHANICAL_PROPOSAL');
  const requirements = [
    {
      id: 'stated-mandate',
      kind: 'mandate',
      sourceHeading: null,
      decidedBy: 'clause',
      quotes: [quote('mandate', spec.mandateQuote)],
    },
  ];
  if (spec.extra) {
    requirements.push({
      id: spec.extra.id,
      kind: 'mandate',
      sourceHeading: null,
      decidedBy: 'clause',
      quotes: [quote(spec.extra.documentId, spec.extra.quote)],
    });
  }
  const mandateIds = requirements.map(item => item.id);
  const mandateQuotes = [
    quote(proposalId, spec.proposalQuote),
    quote('mandate', spec.mandateQuote),
    ...(spec.extra ? [quote(spec.extra.documentId, spec.extra.quote)] : []),
  ];
  const support = [
    quote(proposalId, spec.proposalQuote),
    quote(spec.documents.find(document => document.text.includes(spec.sourceQuote))?.id ?? 'mandate', spec.sourceQuote),
  ];
  return JSON.stringify({
    version: ADAPTER_OUTPUT_VERSION,
    complete: spec.complete !== false,
    grounding: spec.grounding,
    applicability: [
      { checkId: 'decision_basis', status: 'applicable', basis: 'mandatory', documentIds, complete: true },
      { checkId: 'order_strategy_consistency', status: 'applicable', basis: 'mandatory', documentIds, complete: true },
      { checkId: 'mandate_compliance', status: 'applicable', basis: 'explicit_items', documentIds, complete: true },
      { checkId: 'additional_claims', status: 'not_applicable', basis: 'none_in_complete_scope', documentIds, complete: true },
      { checkId: 'numeric_limits', status: 'not_applicable', basis: 'none_in_complete_scope', documentIds, complete: true },
    ],
    detection: [
      { checkId: 'mandate_compliance', state: 'complete', result: 'found' },
      { checkId: 'numeric_limits', state: 'complete', result: 'none' },
      { checkId: 'additional_claims', state: 'complete', result: 'none' },
    ],
    requirements,
    semanticChecks: [
      { checkId: 'decision_basis', status: 'fulfilled', quotes: support, requirementIds: [] },
      { checkId: 'order_strategy_consistency', status: 'fulfilled', quotes: support, requirementIds: [] },
      {
        checkId: 'mandate_compliance',
        status: spec.mandateStatus,
        quotes: mandateQuotes,
        requirementIds: mandateIds,
      },
    ],
    claims: [],
    quantities: [],
    limits: [],
  });
}
