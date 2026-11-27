import { PROMPT_TEMPLATE } from './prompt.ts';

export type ComparisonArm = 'A' | 'B';

/**
 * Baseline label. The prod pot-cli critic and the verify cascade are a
 * different host (see COMPARISON.md). This pilot does not use them.
 */
export const COMPARISON_BASELINE = 'prompt comparison on the #140 extractor' as const;

/**
 * Shared by both arms. Detect missing evidence and unfounded extra
 * requirements. The grounding field is on the shared schema so the wire
 * format does not differ by arm.
 */
export const SHARED_APPENDIX = `Detect missing evidence and unfounded extra requirements. A condition the documents do not impose is not a reason to withhold a release. Missing evidence for a condition the documents do impose is not a release.

Include a grounding field. grounding is null when there is no row. A row has objectionId, clauseDocumentId, clauseQuote, evidenceDocumentId, evidenceQuote, and reading. reading is met, violated, or open. clauseQuote and evidenceQuote are exact original spans. This field does not itself grant a release.`;

/**
 * The only prompt text arm B adds. Arm A does not contain this paragraph.
 */
export const ARM_B_APPENDIX = `For every decisive objection, name the binding clause and explain from the available evidence whether the condition is met, violated, or open. A decisive objection is a semantic check whose status is contradicted, a claim whose status is contradicted, or a limit you emit. clauseQuote is the exact clause in the mandate or policy document. reading is met, violated, or open. Missing evidence for a real obligation is open. Absence of a document cannot be quoted literally: set evidenceQuote to null, evidenceDocumentId to null, and reading to open. Do not drop the objection. A missing or inaccurate quote is not a release.`;

export function armSystemPrompt(arm: ComparisonArm): string {
  const shared = `${PROMPT_TEMPLATE}\n${SHARED_APPENDIX}`;
  return arm === 'B' ? `${shared}\n${ARM_B_APPENDIX}` : shared;
}
