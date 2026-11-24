/**
 * Experimental trade-decision contract.
 * The evaluator does not call a model. A separate offline adapter may parse
 * structured model output into this shape; positions are still checked here.
 */
export const CONTRACT_VERSION = 'trade-contract/v1' as const;
export const CHECK_IDS = [
  'decision_basis',
  'order_strategy_consistency',
  'mandate_compliance',
  'additional_claims',
  'numeric_limits',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];
export type SemanticCheckId = 'decision_basis' | 'order_strategy_consistency' | 'mandate_compliance';
export type Status = 'fulfilled' | 'contradicted' | 'not_verifiable' | 'not_applicable';
export type Decision = 'ALLOW' | 'BLOCK' | 'UNCERTAIN';

export interface Document {
  id: string;
  role: 'proposal' | 'source';
  /** Original text, including original whitespace and line endings. */
  text: string;
}
export interface Evidence {
  documentId: string;
  /** Zero-based JavaScript UTF-16 offsets; end is exclusive. */
  start: number;
  end: number;
  quote: string;
}
export interface Binding {
  subjectId: string;
  measureId: string;
  unit: string;
  /** E.g. account-equity-at-decision, not cash-at-another-time. */
  referenceId: string;
}
export interface Quantity {
  id: string;
  binding: Binding;
  /** Canonical ASCII decimal. Locale punctuation stays in the evidence quote. */
  value: string;
  valueEvidence: Evidence;
  bindingEvidence: Evidence[];
  /**
   * Required when `binding.unit` is `percent`: the exact "percent of what" phrase.
   * Null for every other unit. A missing or competing reference is not verifiable.
   */
  referenceEvidence: Evidence | null;
}
export interface Limit {
  id: string;
  binding: Binding;
  operator: '<' | '<=' | '>' | '>=' | '==';
  value: string;
  valueEvidence: Evidence;
  bindingEvidence: Evidence[];
  /** Same rule as Quantity.referenceEvidence. */
  referenceEvidence: Evidence | null;
  /** Null means no unambiguous matching quantity was extracted. */
  quantityId: string | null;
}
export interface Requirement {
  id: string;
  kind: 'strategy' | 'mandate';
  evidence: Evidence[];
}
export interface Applicability {
  checkId: CheckId;
  status: 'applicable' | 'not_applicable' | 'undetermined';
  basis: 'mandatory' | 'explicit_items' | 'none_in_complete_scope' | 'undetermined';
  /** Must enumerate every input document, even when concluding absence. */
  documentIds: string[];
  complete: boolean;
}
export interface SemanticCheck {
  checkId: SemanticCheckId;
  status: Status;
  evidence: Evidence[];
  /** Exact IDs of all strategy/mandate requirements considered by this check. */
  requirementIds: string[];
}
export interface Claim {
  id: string;
  kind: 'source_fact' | 'inference' | 'calculation' | 'unsubstantiated_new_fact';
  status: Exclude<Status, 'not_applicable'>;
  /** Quote the additional assertion, not a nonexistent quote of source silence. */
  claimEvidence: Evidence;
  supportingEvidence: Evidence[];
  /** Deliberately narrow: exact addition/subtraction of equally bound quantities. */
  calculation: { operation: 'add' | 'subtract'; leftId: string; rightId: string; resultId: string } | null;
}
export interface TradeContractInput {
  version: typeof CONTRACT_VERSION;
  documents: Document[];
  adapter: {
    id: string;
    contractVersion: typeof CONTRACT_VERSION;
    complete: boolean;
    /** SHA-256 of each original UTF-8 document. This is an attestation, not a signature. */
    coverage: { documentId: string; sha256: string }[];
  };
  applicability: Applicability[];
  requirements: Requirement[];
  semanticChecks: SemanticCheck[];
  claims: Claim[];
  quantities: Quantity[];
  limits: Limit[];
}
export interface EvaluationOptions {
  /** Local caller configuration, never accepted from the untrusted input object. */
  trustedAdapterIds: readonly string[];
  diagnostics?: boolean;
}
export interface EvaluationResult {
  version: typeof CONTRACT_VERSION;
  decision: Decision;
  checks: { checkId: CheckId; status: Status }[];
  /** Explicit local opt-in; only fixed codes and schema paths, never input text. */
  diagnostics?: { code: string; path: string }[];
}
