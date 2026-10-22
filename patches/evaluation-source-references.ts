/** Host-addressed source passages. Resolving a selected address never supplies a score or a reason. */
import {createHash} from 'node:crypto';

export type EvidenceSource = 'trace' | 'answer';
export interface SourcePassage {
  ref: string;
  source: EvidenceSource;
  text: string;
  line: number;
  /** Zero-based, end-exclusive UTF-16 offsets into the unmodified source. */
  start: number;
  end: number;
}
export interface SourceReferenceContext {
  sources: Record<EvidenceSource, string>;
  hashes: Record<EvidenceSource, string>;
  steps: ReadonlyMap<string, EvidenceSource>;
  passages: SourcePassage[];
  truncated: boolean;
}
export interface SourceCitationAudit {
  step_id: string;
  status: 'resolved' | 'direct_quote' | 'none' | 'invalid';
  source: EvidenceSource;
  source_sha256: string;
  /** Only a valid host-generated reference is exposed. Unknown model text is never copied. */
  reference_id: string | null;
  start: number | null;
  end: number | null;
}
export interface SourceReferenceAudit {
  schema_version: 'plv.source-references.v1';
  catalog_entries: number;
  catalog_truncated: boolean;
  citations: SourceCitationAudit[];
}

const MAX_PASSAGES = 256;
const MAX_PASSAGE_CHARS = 2048;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Index complete nonblank lines only. The original evidence and its ordering remain untouched. */
export function createSourceReferences(
  sources: Record<EvidenceSource, string>,
  steps: Array<{id: string; source: EvidenceSource}>,
): SourceReferenceContext {
  const context: SourceReferenceContext = {
    sources: {...sources}, hashes: {trace: hash(sources.trace), answer: hash(sources.answer)},
    steps: new Map(steps.map(step => [step.id, step.source])), passages: [], truncated: false,
  };
  const used = new Set(steps.map(step => step.source));
  for (const source of ['trace', 'answer'] as const) {
    if (!used.has(source)) continue;
    let offset = 0;
    sources[source].split('\n').forEach((line, index) => {
      const text = line.trim();
      const start = offset + line.length - line.trimStart().length;
      offset += line.length + 1;
      if (!text) return;
      if (text.length > MAX_PASSAGE_CHARS || context.passages.length >= MAX_PASSAGES) {
        context.truncated = true;
        return;
      }
      context.passages.push({
        ref: `${source === 'trace' ? 'T' : 'A'}${index + 1}_${context.hashes[source].slice(0, 12)}`,
        source, text, line: index + 1, start, end: start + text.length,
      });
    });
  }
  return context;
}

/** Data-only catalog: addresses are not attestations of truth, relevance or contemporaneous reasoning. */
export function sourceReferenceCatalog(context: SourceReferenceContext): string {
  return JSON.stringify({
    schema_version: 'plv.source-references.v1',
    allowed_sources: Object.fromEntries(context.steps),
    truncated: context.truncated,
    passages: context.passages.map(({ref, source, text}) => ({ref, source, text})),
  });
}

/** Resolve only the model's explicit selection, before the unchanged provenance checks and score floors. */
export function resolveSourceReferences(
  rows: Record<string, unknown>[], context: SourceReferenceContext,
): {data: Record<string, unknown>[]; audit: SourceReferenceAudit; invalidSteps: string[]} {
  const audit: SourceReferenceAudit = {schema_version: 'plv.source-references.v1',
    catalog_entries: context.passages.length, catalog_truncated: context.truncated, citations: []};
  const invalidSteps: string[] = [];
  const byId = new Map(context.passages.map(passage => [passage.ref, passage]));
  const data = rows.map(row => {
    const id = row.step_id as string;
    const source = context.steps.get(id);
    if (!source) throw Error('SOURCE_REFERENCE_STEP_NOT_EXPECTED');
    const result = {...row};
    // Never pass model-supplied reference/location metadata off as host diagnostics.
    delete result.quote_ref;
    delete result.source_reference;
    const citation: SourceCitationAudit = {step_id: id,
      status: typeof row.quote === 'string' ? 'direct_quote' : 'none', source,
      source_sha256: context.hashes[source], reference_id: null, start: null, end: null};
    if (row.quote_ref !== undefined && row.quote_ref !== null) {
      const selected = typeof row.quote_ref === 'string' ? byId.get(row.quote_ref) : undefined;
      // Mixed text/reference forms must agree exactly; a valid address never repairs a fabricated quote.
      const valid = selected && selected.source === source
        && hash(context.sources[source]) === context.hashes[source]
        && context.sources[source].slice(selected.start, selected.end) === selected.text
        && (row.quote === null || row.quote === selected.text);
      if (!valid) {
        citation.status = 'invalid';
        invalidSteps.push(id);
      } else {
        result.quote = selected.text;
        result.quote_location = {line_start: selected.line, line_end: selected.line,
          char_offset_start: selected.start, char_offset_end: selected.end, turn: null};
        citation.status = 'resolved';
        citation.reference_id = selected.ref;
        citation.start = selected.start;
        citation.end = selected.end;
      }
    }
    if (audit.citations.length < 128) audit.citations.push(citation);
    return result;
  });
  return {data, audit, invalidSteps};
}
