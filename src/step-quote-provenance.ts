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
 * `Principal mandate (verbatim quote):` span in `evidence`.
 *
 * Surface contract:
 *   - quotes are evidence substrings (or null) — all modes, not only
 *     action_authorization
 *   - null/undefined never become the literal prefix `undefined`
 *   - recovered cites are labeled `quote_source: recovered_mandate`
 *   - hard unfaithful + real scope/objective prose is left intact
 */

/** Cross-repo contract with thoughtproof-mcp `buildSentinelEvidence`. */
export const MCP_EVIDENCE_MANDATE_LABEL = 'Principal mandate (verbatim quote):';
export const MCP_EVIDENCE_ACTION_LABEL = 'Proposed action:';
export const MCP_EVIDENCE_REASONING_LABEL = 'Agent reasoning:';

export const PROVENANCE_DOWNGRADE_STAMP =
  '[PROVENANCE DOWNGRADE: quote invalid or missing]';
export const RECOVERED_MANDATE_NOTE =
  'provenance recovered from host mandate span';

const PROVENANCE_STAMP_RE =
  /\[PROVENANCE DOWNGRADE:\s*quote invalid or missing\]/i;

export type QuoteSource = 'cascade' | 'recovered_mandate';
export type QuoteMatchMode =
  | 'exact'
  | 'trimmed'
  | 'line_whitespace'
  | 'unicode'
  | 'none';

export interface QuoteMatch {
  matched: boolean;
  /** Substring of `evidence` that satisfied the match, when recoverable. */
  span: string | null;
  match_mode: QuoteMatchMode;
}

/**
 * Coerce LLM / cascade quote fields to `string | null`.
 *
 * Kept in lockstep with vendored pot-cli `coerceQuote` via
 * `src/pot-cli-quote-patch.test.ts` parity cases. Never returns the
 * strings `"undefined"` or `"null"`.
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

function buildNormalizedIndexMap(
  original: string,
  normalize: (ch: string) => string,
): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < original.length; i++) {
    const n = normalize(original[i]!);
    for (let k = 0; k < n.length; k++) {
      text += n[k];
      map.push(i);
    }
  }
  return { text, map };
}

/**
 * Match `quote` against `evidence` and return the actually matched
 * evidence span (not the LLM's possibly folded form).
 */
export function matchEvidenceQuote(quote: string, evidence: string): QuoteMatch {
  if (!quote || !evidence) {
    return { matched: false, span: null, match_mode: 'none' };
  }
  if (evidence.includes(quote)) {
    return { matched: true, span: quote, match_mode: 'exact' };
  }
  const cleanQuote = quote.replace(/\.{2,}\s*$/, '').replace(/…\s*$/, '').trim();
  if (cleanQuote && evidence.includes(cleanQuote)) {
    return { matched: true, span: cleanQuote, match_mode: 'trimmed' };
  }
  const normTrace = evidence.replace(/^[ \t]+/gm, '');
  const normQuote = cleanQuote.replace(/^[ \t]+/gm, '');
  if (normQuote && normTrace.includes(normQuote)) {
    const span = evidence.includes(normQuote) ? normQuote : normQuote;
    return { matched: true, span, match_mode: 'line_whitespace' };
  }
  const uni = buildNormalizedIndexMap(evidence, (ch) => normalizeUnicodeForMatch(ch));
  const uniQuote = normalizeUnicodeForMatch(cleanQuote);
  if (uniQuote.length > 0) {
    const idx = uni.text.indexOf(uniQuote);
    if (idx !== -1) {
      const start = uni.map[idx]!;
      const end = uni.map[idx + uniQuote.length - 1]! + 1;
      return {
        matched: true,
        span: evidence.slice(start, end),
        match_mode: 'unicode',
      };
    }
  }
  return { matched: false, span: null, match_mode: 'none' };
}

export function isEvidenceSubstring(quote: string, evidence: string): boolean {
  return matchEvidenceQuote(quote, evidence).matched;
}

/**
 * Extract the MCP-embedded mandate span from evidence.
 *
 * Format (thoughtproof-mcp `buildSentinelEvidence`, undeclared until this
 * module — labels are the contract):
 *
 *   Principal mandate (verbatim quote):
 *   <mandate or qualifying host quote>
 *
 *   Proposed action:
 *   …
 *
 * No character-count floor. MCP's 20-char rule is host-excerpt fallback
 * only (review suggestion that landed as HOST_QUOTE_MIN_CHARS on the
 * optional host `quote`, not on the embedded span).
 */
export function extractMandateVerbatimQuote(evidence: string): string | null {
  if (!evidence) return null;
  const labelRe = new RegExp(
    MCP_EVIDENCE_MANDATE_LABEL.replace(/[()]/g, '\\$&'),
    'i',
  );
  const labelMatch = evidence.match(labelRe);
  if (!labelMatch || labelMatch.index === undefined) return null;
  const after = evidence.slice(labelMatch.index + labelMatch[0].length);
  const cut = after.search(
    new RegExp(
      `\\n(?:${MCP_EVIDENCE_ACTION_LABEL}|${MCP_EVIDENCE_REASONING_LABEL})`,
      'i',
    ),
  );
  const raw = (cut === -1 ? after : after.slice(0, cut)).trim();
  if (!raw) return null;
  const m = matchEvidenceQuote(raw, evidence);
  return m.matched && m.span ? m.span : null;
}

export function sanitizeReasoning(reasoning: unknown): string {
  if (reasoning == null) return '';
  let s = String(reasoning);
  if (/^(undefined|null)$/i.test(s.trim())) return '';
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
  quote_source: QuoteSource | null;
  match_mode: QuoteMatchMode;
  recovered_quote: boolean;
  false_provenance_stripped: boolean;
}

const MISSING_CITE_OBJECTION =
  'Step quote is missing and is not a citeable substring of the supplied evidence.';
const NON_SUBSTRING_OBJECTION =
  'Step quote is not a substring of the supplied evidence.';
const RECOVERED_FALLBACK = `Provenance recovered from host mandate span.`;

function withRecoveredNote(reasoning: string): string {
  if (reasoning.toLowerCase().includes(RECOVERED_MANDATE_NOTE)) return reasoning;
  if (!reasoning) return RECOVERED_FALLBACK;
  return appendReasoningNote(reasoning, `[${RECOVERED_MANDATE_NOTE}]`);
}

/**
 * Normalize one cascade step for the Sentinel objection surface.
 *
 * Recovered cites are labeled and annotated so a signed receipt cannot
 * imply the cascade cited the mandate span.
 */
export function normalizeStepQuote(
  step: StepQuoteInput,
  evidence: string,
): NormalizedStepQuote {
  const rawQuote = coerceQuote(step.quote);
  const quoteWasPresent = rawQuote !== null;

  let quote: string | null = null;
  let quote_source: QuoteSource | null = null;
  let match_mode: QuoteMatchMode = 'none';
  let recovered_quote = false;

  if (rawQuote !== null) {
    const m = matchEvidenceQuote(rawQuote, evidence);
    if (m.matched && m.span) {
      quote = m.span;
      quote_source = 'cascade';
      match_mode = m.match_mode;
    }
  }

  if (!quoteWasPresent && quote === null) {
    const recovered = extractMandateVerbatimQuote(evidence);
    if (recovered) {
      const m = matchEvidenceQuote(recovered, evidence);
      if (m.matched && m.span) {
        quote = m.span;
        quote_source = 'recovered_mandate';
        match_mode = m.match_mode;
        recovered_quote = true;
      }
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
      reasoning = stripProvenanceDowngradeStamp(reasoning);
      false_provenance_stripped = true;
    }
  } else if (quoteWasPresent && quote === null && !reasoning) {
    reasoning = NON_SUBSTRING_OBJECTION;
  }

  if (recovered_quote) {
    reasoning = withRecoveredNote(reasoning);
  }

  return {
    quote,
    reasoning,
    quote_source,
    match_mode,
    recovered_quote,
    false_provenance_stripped,
  };
}

export function normalizeCascadeSteps<T extends StepQuoteInput>(
  steps: T[],
  evidence: string,
): Array<T & NormalizedStepQuote> {
  return (steps ?? []).map((s) => {
    const n = normalizeStepQuote(s, evidence);
    return { ...s, ...n };
  });
}
