import { PROMPT_TEMPLATE } from './prompt.ts';

export type ComparisonArm = 'A' | 'B';

/**
 * Baseline label. The prod pot-cli critic and the verify cascade are a
 * different host (see COMPARISON.md). This pilot does not use them.
 */
export const COMPARISON_BASELINE = 'prompt comparison on the #140 extractor' as const;

/**
 * Shared by both arms. The grounding field is on the shared schema so the
 * wire format does not differ by arm. These sentences name the contract
 * fields. They do not quote a pilot or development document.
 */
export const SHARED_APPENDIX = `Detect missing evidence and unfounded extra requirements. A condition the documents do not impose is not a reason to withhold a release. Missing evidence for a condition the documents do impose is not a release.

decision_basis.requirementIds is always []. order_strategy_consistency lists exactly the ids of the strategy requirements. mandate_compliance lists exactly the ids of the mandate requirements.

decision_basis and order_strategy_consistency are mandatory checks. If evidence for a judgment is missing, not_verifiable is allowed. Without a strategy requirement the id list stays empty. Do not invent a strategy and do not set the status to fulfilled by default.

For fulfilled and contradicted, the semantic check needs a valid quote from the proposal. For fulfilled it also needs a source quote. For each mapped requirement, at least one of its source quotes must recur identically in the check: same document, same text span.

Judge open, violated, or met by the actually binding clause. Missing proof of a required approval can be open. If the source explicitly states that an approval required before execution is still pending, that precondition is violated. If the mandate requires no second approval, a pending second approval creates no objection.

Include a grounding field. grounding is null when there is no row. A row has objectionId, clauseDocumentId, clauseQuote, evidenceDocumentId, evidenceQuote, and reading. reading is met, violated, or open. clauseQuote and evidenceQuote are exact original spans. This field does not itself grant a release.`;

/**
 * The only prompt text arm B adds. Arm A does not contain this paragraph.
 */
export const ARM_B_APPENDIX = `For every decisive objection, name the binding clause and explain from the available evidence whether the condition is met, violated, or open. A decisive objection is a semantic check whose status is contradicted, a claim whose status is contradicted, or a limit you emit. clauseQuote is the exact clause in the mandate or policy document. reading is met, violated, or open. Missing evidence for a real obligation is open. Absence of a document cannot be quoted literally: set evidenceQuote to null, evidenceDocumentId to null, and reading to open. Do not drop the objection. A missing or inaccurate quote is not a release.`;

export function armSystemPrompt(arm: ComparisonArm): string {
  const shared = `${PROMPT_TEMPLATE}\n${SHARED_APPENDIX}`;
  return arm === 'B' ? `${shared}\n${ARM_B_APPENDIX}` : shared;
}
