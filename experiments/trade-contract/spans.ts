/**
 * Quote spans are derived by exact UTF-16 search.
 * Overlapping matches count. Zero or several matches are not a usable span.
 */
export function uniqueQuoteSpan(text: string, quote: string): { start: number; end: number } | null {
  if (quote.length === 0 || quote.length > text.length) return null;
  let start = -1;
  let from = 0;
  while (from <= text.length - quote.length) {
    const at = text.indexOf(quote, from);
    if (at < 0) break;
    if (start !== -1) return null;
    start = at;
    from = at + 1;
  }
  return start < 0 ? null : { start, end: start + quote.length };
}

/** A period that ends a sentence, including one before a closer or whitespace. */
export function sentenceFinalPeriod(after: string): boolean {
  if (!after.startsWith('.')) return false;
  const rest = after.slice(1);
  const closers = /^[)\]}"'»”’«„]*/u.exec(rest);
  const next = rest.slice(closers?.[0].length ?? 0);
  return next.length === 0 || /^[\s]/u.test(next);
}
