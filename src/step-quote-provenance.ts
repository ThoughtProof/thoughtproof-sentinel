/**
 * Cascade step-quote provenance (Sentinel surface).
 *
 * pot-cli 0.8.10 coerceQuote maps omitted LLM `quote` to null (stops the
 * CB4A `.replace` crash). The remaining dogfood failure (2026-09-09):
 * serv-nano emits `quote: null` and omits `reasoning`, then
 * `processed.reasoning += ' [PROVENANCE DOWNGRADE: …]'` stringifies to
 * `undefined [PROVENANCE DOWNGRADE: quote invalid or missing]`.
 *
 * On weakly_faithful (score 0.25 after the provenance cap) that stamp is
 * especially misleading when MCP already embedded a citeable
 * `Principal mandate (verbatim quote):` span in `evidence` (MCP PR #18).
 *
 * This module is the Sentinel-side contract:
 *   - quotes used on the surface are evidence substrings (or null)
 *   - null/undefined never become the literal prefix `undefined`
 *   - near-pass + mandate span → recover cite / strip false provenance theater
 *   - hard unfaithful + real scope/objective prose is left intact
 */

export const MANDATE_VERBATIM_LABEL = 'Principal mandate (verbatim quote):';
export const PROVENANCE_DOWNGRADE_STAMP =
  '[PROVENANCE DOWNGRADE: quote invalid or missing]';
/** MCP host-quote floor (thoughtproof-mcp PR #18): ≥ 20 chars after trim. */
export const MANDATE_QUOTE_MIN_CHARS = 20;

const PROVENANCE_STAMP_RE =
  /\[PROVENANCE DOWNGRADE:\s*quote invalid or missing\]/i;

/**
 * Coerce LLM / cascade quote fields to `string | null`.
 *
 * Never returns the strings `"undefined"` or `"null"` — those are JS
 * stringification artifacts, not citeable spans.
 */
export function coerceQuote(quote: unknown): string | null {
  if (quote == null) return null;
  if (typeof quote === 'string') {
    const t = quote.trim();
    if (t.length === 0) return null;
    if (t === 'undefined' || t === 'null') return null;
    return quote;
  }
  try {
    const s = String(quote);
    if (s === 'undefined' || s === 'null' || s.trim().length === 0) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * Append a provenance/floor note without the JS `undefined + string` artifact.
 *
 * `undefined + ' [PROVENANCE DOWNGRADE: …]'` ===
 * `'undefined [PROVENANCE DOWNGRADE: …]'`.
 */
export function appendReasoningNote(reasoning: unknown, note: string): string {
  const raw = reasoning == null ? '' : String(reasoning);
  const base = raw === 'undefined' || raw === 'null' ? '' : raw;
  const suffix = note.startsWith(' ') ? note : ` ${note}`;
  return base ? `${base}${suffix}` : suffix.trimStart();
}

/** pot-cli Mode-1 punctuation fold (smart quotes, dashes, zwc, NFKC). */
export function normalizeUnicodeForMatch(s: string): string {
  if (s == null) return '';
  return String(s)
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

export function isEvidenceSubstring(quote: string, evidence: string): boolean {
  if (!quote || !evidence) return false;
  if (evidence.includes(quote)) return true;
  const cleanQuote = quote.replace(/\.{2,}\s*$/, '').replace(/…\s*$/, '').trim();
  if (cleanQuote && evidence.includes(cleanQuote)) return true;
  const normTrace = evidence.replace(/^[ \t]+/gm, '');
  const normQuote = cleanQuote.replace(/^[ \t]+/gm, '');
  if (normQuote && normTrace.includes(normQuote)) return true;
  const uniQuote = normalizeUnicodeForMatch(cleanQuote);
  const uniTrace = normalizeUnicodeForMatch(evidence);
  return uniQuote.length > 0 && uniTrace.includes(uniQuote);
}

/**
 * Extract the MCP-embedded mandate span from evidence.
 * Format (thoughtproof-mcp PR #18):
 *
 *   Principal mandate (verbatim quote):
 *   <mandate or qualifying host quote>
 *
 *   Proposed action:
 *   …
 */
export function extractMandateVerbatimQuote(evidence: string): string | null {
  if (!evidence) return null;
  const labelRe = /Principal mandate \(verbatim quote\):/i;
  const labelMatch = evidence.match(labelRe);
  if (!labelMatch || labelMatch.index === undefined) return null;
  const after = evidence.slice(labelMatch.index + labelMatch[0].length);
  const cut = after.search(/\n(?:Proposed action:|Agent reasoning:)/i);
  const raw = (cut === -1 ? after : after.slice(0, cut)).trim();
  if (raw.length < MANDATE_QUOTE_MIN_CHARS) return null;
  if (!isEvidenceSubstring(raw, evidence)) return null;
  return raw;
}

export function sanitizeReasoning(reasoning: unknown): string {
  if (reasoning == null) return '';
  let s = String(reasoning);
  if (/^(undefined|null)$/i.test(s.trim())) return '';
  // JS concat artifact: undefined + ' [PROVENANCE…]' / ' [FLOOR:…]'
  s = s.replace(/^(?:undefined|null)(?=\s*\[)/, '');
  return s.trim();
}

export function hasProvenanceDowngradeStamp(reasoning: string): boolean {
  return PROVENANCE_STAMP_RE.test(reasoning);
}

export function stripProvenanceDowngradeStamp(reasoning: string): string {
  return reasoning
    .replace(/\[PROVENANCE DOWNGRADE:\s*quote invalid or missing\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface StepQuoteInput {
  quote?: unknown;
  reasoning?: unknown;
  predicate?: unknown;
  score?: unknown;
}

export interface NormalizedStepQuote {
  quote: string | null;
  reasoning: string;
  recovered_quote: boolean;
  false_provenance_stripped: boolean;
}

const MISSING_CITE_OBJECTION =
  'Step quote is missing and is not a citeable substring of the supplied evidence.';
const NON_SUBSTRING_OBJECTION =
  'Step quote is not a substring of the supplied evidence.';

/**
 * Normalize one cascade step for the Sentinel objection surface.
 *
 * - Quote is null or an evidence substring (never a hallucinated span).
 * - When cascade omitted quote but evidence has the MCP mandate span, recover it.
 * - `undefined [PROVENANCE DOWNGRADE:…]` becomes a well-formed message.
 * - Near-pass + recovered mandate span: strip false provenance theater.
 * - Hard unfaithful with real scope/objective prose: keep that prose.
 */
export function normalizeStepQuote(
  step: StepQuoteInput,
  evidence: string,
): NormalizedStepQuote {
  const rawQuote = coerceQuote(step.quote);
  const quoteWasPresent = rawQuote !== null;
  let quote: string | null = rawQuote;
  if (quote !== null && !isEvidenceSubstring(quote, evidence)) {
    quote = null;
  }

  let recovered_quote = false;
  if (!quoteWasPresent && quote === null) {
    const recovered = extractMandateVerbatimQuote(evidence);
    if (recovered && isEvidenceSubstring(recovered, evidence)) {
      quote = recovered;
      recovered_quote = true;
    }
  }

  let reasoning = sanitizeReasoning(step.reasoning);
  let false_provenance_stripped = false;
  const stamped = hasProvenanceDowngradeStamp(reasoning);

  if (stamped) {
    if (recovered_quote && quote !== null) {
      reasoning = stripProvenanceDowngradeStamp(reasoning);
      false_provenance_stripped = true;
    } else if (quoteWasPresent && quote === null) {
      reasoning = stripProvenanceDowngradeStamp(reasoning);
      if (!reasoning) reasoning = NON_SUBSTRING_OBJECTION;
    } else if (quote === null) {
      reasoning = stripProvenanceDowngradeStamp(reasoning);
      if (!reasoning) reasoning = MISSING_CITE_OBJECTION;
    } else {
      // Quote already a valid evidence substring — stamp is theater
      reasoning = stripProvenanceDowngradeStamp(reasoning);
      false_provenance_stripped = true;
    }
  } else if (quoteWasPresent && quote === null && !reasoning) {
    reasoning = NON_SUBSTRING_OBJECTION;
  }

  return { quote, reasoning, recovered_quote, false_provenance_stripped };
}

export function normalizeCascadeSteps<T extends StepQuoteInput>(
  steps: T[],
  evidence: string,
): Array<T & { quote: string | null; reasoning: string }> {
  return (steps ?? []).map((s) => {
    const n = normalizeStepQuote(s, evidence);
    return { ...s, quote: n.quote, reasoning: n.reasoning };
  });
}
