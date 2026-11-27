import { PROMPT_TEMPLATE } from './prompt.ts';

export type ComparisonArm = 'A' | 'B';

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
export const ARM_B_APPENDIX = `For every decisive objection you still emit, add one grounding row. A decisive objection is a semantic check whose status is contradicted, a claim whose status is contradicted, or a limit you emit. clauseQuote must be the clause in the authorized mandate or applicable policy that makes the condition binding, and clauseDocumentId must name that mandate or policy document. evidenceQuote must be pre-action evidence that shows the condition met, violated, or open. If you cannot ground a claimed obligation that way, drop that objection: do not emit it as contradicted, and do not emit its requirement, claim, or limit. An authorized action with sufficient evidence for every condition that does apply is still required before a release.`;

export function armSystemPrompt(arm: ComparisonArm): string {
  const shared = `${PROMPT_TEMPLATE}\n${SHARED_APPENDIX}`;
  return arm === 'B' ? `${shared}\n${ARM_B_APPENDIX}` : shared;
}
