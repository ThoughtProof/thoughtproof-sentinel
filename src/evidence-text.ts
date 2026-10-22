/**
 * Existing /sentinel/verify evidence contract: ECMAScript String#trim only.
 * Hash the UTF-8 encoding of this text. Preserve internal whitespace, line
 * endings, Unicode composition and JSON formatting; do not parse/reserialize.
 * This is text normalization, not validation or permission to execute.
 */
export function normalizeEvidenceText(evidence: string): string {
  return evidence.trim();
}
