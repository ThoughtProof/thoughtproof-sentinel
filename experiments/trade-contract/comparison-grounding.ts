import type { Document } from './contract.ts';
import { uniqueQuoteSpan } from './spans.ts';

export type Reading = 'met' | 'violated' | 'open';

export interface GroundingRow {
  objectionId: string;
  clauseDocumentId: string;
  clauseQuote: string;
  /** Null when the evidence document is absent and reading is open. */
  evidenceDocumentId: string | null;
  evidenceQuote: string | null;
  reading: Reading;
}

export interface PreparedContent {
  preGateContent: string;
  publicContent: string;
  droppedIds: string[];
  schemaFailure: boolean;
  /** True when the payload was not JSON. Distinct from a frozen-validator rejection. */
  parseFailure: boolean;
  grounding: GroundingRow[];
}

const ROOT_KEYS = [
  'version', 'complete', 'applicability', 'detection', 'requirements',
  'semanticChecks', 'claims', 'quantities', 'limits',
] as const;
const CHECK_IDS = [
  'decision_basis', 'order_strategy_consistency', 'mandate_compliance',
  'additional_claims', 'numeric_limits',
] as const;
const SEMANTIC_IDS = ['decision_basis', 'order_strategy_consistency', 'mandate_compliance'] as const;
const DETECTION_IDS = ['mandate_compliance', 'numeric_limits', 'additional_claims'] as const;

function isPlain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlain(value)) return false;
  const present = Object.keys(value);
  return present.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isPlain) : [];
}

function authorizedClauseDocument(id: string): boolean {
  return id === 'mandate' || id.startsWith('mandate-') || id === 'policy' || id.startsWith('policy-');
}

function spanOk(documents: readonly Document[], id: string, quote: string): boolean {
  if (quote.trim().length === 0) return false;
  const document = documents.find(item => item.id === id);
  if (!document) return false;
  return uniqueQuoteSpan(document.text, quote) !== null;
}

export function validGrounding(row: GroundingRow, documents: readonly Document[]): boolean {
  return authorizedClauseDocument(row.clauseDocumentId)
    && spanOk(documents, row.clauseDocumentId, row.clauseQuote)
    && row.evidenceDocumentId !== null
    && row.evidenceQuote !== null
    && spanOk(documents, row.evidenceDocumentId, row.evidenceQuote);
}

const OPEN_CONDITION = /\b(?:pending|not on file|still pending)\b/i;

function contentWords(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/\p{L}{5,}/gu) ?? []);
}

function sharesContentWord(left: string, right: string): boolean {
  const words = contentWords(left);
  for (const word of contentWords(right)) if (words.has(word)) return true;
  return false;
}

/**
 * Shared host rule for both arms. A missing, inaccurate, irrelevant, or
 * open quote cannot support a release. Open may omit the evidence quote.
 */
export function quoteBlocksRelease(row: GroundingRow, documents: readonly Document[]): boolean {
  if (row.reading === 'open' || row.reading === 'violated') return true;
  if (row.evidenceQuote === null || row.evidenceDocumentId === null) return true;
  if (!spanOk(documents, row.clauseDocumentId, row.clauseQuote)) return true;
  if (!spanOk(documents, row.evidenceDocumentId, row.evidenceQuote)) return true;
  if (OPEN_CONDITION.test(row.evidenceQuote)) return true;
  return !sharesContentWord(row.clauseQuote, row.evidenceQuote);
}

export function applySharedHost(
  decision: 'ALLOW' | 'BLOCK' | 'UNCERTAIN',
  grounding: readonly GroundingRow[],
  documents: readonly Document[],
): 'ALLOW' | 'BLOCK' | 'UNCERTAIN' {
  if (decision !== 'ALLOW') return decision;
  return grounding.some(row => quoteBlocksRelease(row, documents)) ? 'UNCERTAIN' : decision;
}

function quoteRow(value: unknown): boolean {
  return exactKeys(value, ['documentId', 'quote'])
    && typeof value.documentId === 'string' && value.documentId.length > 0
    && typeof value.quote === 'string';
}

function idList(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

function oneEach(group: Record<string, unknown>[], key: string, expected: readonly string[]): boolean {
  return group.length === expected.length
    && expected.every(id => group.filter(item => item[key] === id).length === 1);
}

/** Shallow mirror of the frozen adapter parser's rejection reasons. */
export function structurallyAcceptable(root: Record<string, unknown>): boolean {
  if (!exactKeys(root, ROOT_KEYS)) return false;
  if (root.version !== 'trade-contract-adapter/v1' || typeof root.complete !== 'boolean') return false;
  if (!Array.isArray(root.applicability) || !Array.isArray(root.detection)
    || !Array.isArray(root.requirements) || !Array.isArray(root.semanticChecks)
    || !Array.isArray(root.claims) || !Array.isArray(root.quantities) || !Array.isArray(root.limits)) {
    return false;
  }
  const applicability = rows(root.applicability);
  if (applicability.length !== root.applicability.length) return false;
  for (const row of applicability) {
    if (!exactKeys(row, ['checkId', 'status', 'basis', 'documentIds', 'complete'])) return false;
    if (!CHECK_IDS.includes(row.checkId as typeof CHECK_IDS[number])) return false;
    if (!['applicable', 'not_applicable', 'undetermined'].includes(String(row.status))) return false;
    if (!['mandatory', 'explicit_items', 'none_in_complete_scope', 'undetermined'].includes(String(row.basis))) return false;
    if (typeof row.complete !== 'boolean' || !idList(row.documentIds)) return false;
  }
  if (!oneEach(applicability, 'checkId', CHECK_IDS)) return false;
  const detection = rows(root.detection);
  if (detection.length !== root.detection.length) return false;
  for (const row of detection) {
    if (!exactKeys(row, ['checkId', 'state', 'result'])) return false;
    if (!DETECTION_IDS.includes(row.checkId as typeof DETECTION_IDS[number])) return false;
    if (!['complete', 'incomplete', 'uncertain'].includes(String(row.state))) return false;
    if (!['found', 'none'].includes(String(row.result))) return false;
  }
  if (!oneEach(detection, 'checkId', DETECTION_IDS)) return false;
  const semantic = rows(root.semanticChecks);
  if (semantic.length !== root.semanticChecks.length) return false;
  for (const row of semantic) {
    if (!exactKeys(row, ['checkId', 'status', 'quotes', 'requirementIds'])) return false;
    if (!SEMANTIC_IDS.includes(row.checkId as typeof SEMANTIC_IDS[number])) return false;
    if (!['fulfilled', 'contradicted', 'not_verifiable', 'not_applicable'].includes(String(row.status))) return false;
    if (!Array.isArray(row.quotes) || !row.quotes.every(quoteRow) || !idList(row.requirementIds)) return false;
  }
  if (!oneEach(semantic, 'checkId', SEMANTIC_IDS)) return false;
  for (const row of rows(root.requirements)) {
    if (!exactKeys(row, ['id', 'kind', 'sourceHeading', 'decidedBy', 'quotes'])) return false;
    if (typeof row.id !== 'string' || !['strategy', 'mandate'].includes(String(row.kind))) return false;
    if (!(row.sourceHeading === null || typeof row.sourceHeading === 'string')) return false;
    if (!['clause', 'section_heading', 'undetermined'].includes(String(row.decidedBy))) return false;
    if (!Array.isArray(row.quotes) || !row.quotes.every(quoteRow)) return false;
  }
  return true;
}

function parseGrounding(value: unknown): GroundingRow[] {
  if (!Array.isArray(value)) return [];
  const parsed: GroundingRow[] = [];
  for (const item of value) {
    if (!exactKeys(item, [
      'objectionId', 'clauseDocumentId', 'clauseQuote', 'evidenceDocumentId', 'evidenceQuote', 'reading',
    ])) continue;
    if (item.reading !== 'met' && item.reading !== 'violated' && item.reading !== 'open') continue;
    if (typeof item.objectionId !== 'string' || typeof item.clauseDocumentId !== 'string'
      || typeof item.clauseQuote !== 'string') continue;
    if (!(item.evidenceDocumentId === null || typeof item.evidenceDocumentId === 'string')) continue;
    if (!(item.evidenceQuote === null || typeof item.evidenceQuote === 'string')) continue;
    parsed.push({
      objectionId: item.objectionId,
      clauseDocumentId: item.clauseDocumentId,
      clauseQuote: item.clauseQuote,
      evidenceDocumentId: item.evidenceDocumentId,
      evidenceQuote: item.evidenceQuote,
      reading: item.reading,
    });
  }
  return parsed;
}

function grounded(rows: GroundingRow[], id: string, documents: readonly Document[]): GroundingRow | null {
  return rows.find(row => row.objectionId === id && validGrounding(row, documents)) ?? null;
}

function setApplicability(
  root: Record<string, unknown>, checkId: string, status: string, basis: string,
): void {
  const row = rows(root.applicability).find(item => item.checkId === checkId);
  if (!row) return;
  row.status = status;
  row.basis = basis;
  row.complete = true;
}

function setDetection(root: Record<string, unknown>, checkId: string, result: 'found' | 'none'): void {
  const row = rows(root.detection).find(item => item.checkId === checkId);
  if (!row) return;
  row.state = 'complete';
  row.result = result;
}

function dropSemantic(root: Record<string, unknown>, documents: readonly Document[], grounding: GroundingRow[]): string[] {
  const dropped = new Set<string>();
  for (const check of rows(root.semanticChecks)) {
    if (check.status !== 'contradicted') continue;
    const ids = Array.isArray(check.requirementIds)
      ? check.requirementIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (ids.length === 0 && typeof check.checkId === 'string') {
      const row = grounded(grounding, check.checkId, documents);
      if (!row || row.reading === 'met') {
        check.status = Array.isArray(check.quotes) && check.quotes.length > 0 ? 'fulfilled' : 'not_verifiable';
      } else if (row.reading === 'open') check.status = 'not_verifiable';
      continue;
    }
    const kept: string[] = [];
    let open = false;
    let violated = false;
    for (const id of ids) {
      const row = grounded(grounding, id, documents);
      if (!row) {
        dropped.add(id);
        continue;
      }
      kept.push(id);
      if (row.reading === 'violated') violated = true;
      else if (row.reading === 'open') open = true;
    }
    check.requirementIds = kept;
    if (violated) check.status = 'contradicted';
    else if (open) check.status = 'not_verifiable';
    else if (kept.length === 0 && check.checkId === 'mandate_compliance') {
      check.status = 'not_applicable';
      check.quotes = [];
      check.requirementIds = [];
    } else {
      check.status = Array.isArray(check.quotes) && check.quotes.length > 0 ? 'fulfilled' : 'not_verifiable';
    }
  }
  const requirements = rows(root.requirements);
  root.requirements = requirements.filter(item => !(typeof item.id === 'string' && dropped.has(item.id)));
  const mandateLeft = rows(root.requirements).filter(item => item.kind === 'mandate').length;
  const mandateCheck = rows(root.semanticChecks).find(item => item.checkId === 'mandate_compliance');
  if (mandateCheck?.status === 'not_applicable' && mandateLeft === 0) {
    setApplicability(root, 'mandate_compliance', 'not_applicable', 'none_in_complete_scope');
    setDetection(root, 'mandate_compliance', 'none');
  }
  return [...dropped];
}

function dropClaims(root: Record<string, unknown>, documents: readonly Document[], grounding: GroundingRow[]): string[] {
  const dropped: string[] = [];
  const kept: Record<string, unknown>[] = [];
  for (const claim of rows(root.claims)) {
    if (claim.status !== 'contradicted' || typeof claim.id !== 'string') {
      kept.push(claim);
      continue;
    }
    const row = grounded(grounding, claim.id, documents);
    if (!row || row.reading === 'met') {
      dropped.push(claim.id);
      continue;
    }
    if (row.reading === 'open') claim.status = 'not_verifiable';
    kept.push(claim);
  }
  root.claims = kept;
  if (kept.length === 0) {
    setApplicability(root, 'additional_claims', 'not_applicable', 'none_in_complete_scope');
    setDetection(root, 'additional_claims', 'none');
  }
  return dropped;
}

function dropLimits(root: Record<string, unknown>, documents: readonly Document[], grounding: GroundingRow[]): string[] {
  const dropped: string[] = [];
  const kept: Record<string, unknown>[] = [];
  let open = false;
  for (const limit of rows(root.limits)) {
    if (typeof limit.id !== 'string') continue;
    const row = grounded(grounding, limit.id, documents);
    if (!row) {
      dropped.push(limit.id);
      continue;
    }
    if (row.reading === 'open') {
      open = true;
      dropped.push(limit.id);
      continue;
    }
    kept.push(limit);
  }
  root.limits = kept;
  if (open) {
    setApplicability(root, 'numeric_limits', 'undetermined', 'undetermined');
    setDetection(root, 'numeric_limits', kept.length === 0 ? 'none' : 'found');
  } else if (kept.length === 0) {
    setApplicability(root, 'numeric_limits', 'not_applicable', 'none_in_complete_scope');
    setDetection(root, 'numeric_limits', 'none');
  }
  return dropped;
}

function applyDrop(root: Record<string, unknown>, documents: readonly Document[], grounding: GroundingRow[]): string[] {
  return [
    ...dropSemantic(root, documents, grounding),
    ...dropClaims(root, documents, grounding),
    ...dropLimits(root, documents, grounding),
  ];
}

const EMPTY_PREPARED = (content: string): PreparedContent => ({
  preGateContent: content,
  publicContent: content,
  droppedIds: [],
  schemaFailure: true,
  parseFailure: true,
  grounding: [],
});

/**
 * Primary path. Both arms use this. Grounding is stripped before the frozen
 * parser and is not used to drop objections. `legacy-drop-replay` is the
 * previous B filter, labelled and never the primary result.
 */
export function prepareModelContent(
  content: string,
  documents: readonly Document[],
  mode: 'primary' | 'legacy-drop-replay' = 'primary',
): PreparedContent {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return EMPTY_PREPARED(content);
  }
  if (!isPlain(raw)) return EMPTY_PREPARED(content);
  const grounding = parseGrounding(raw.grounding);
  delete raw.grounding;
  const schemaFailure = !structurallyAcceptable(raw);
  const preGate = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const published = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const droppedIds = mode === 'legacy-drop-replay' && !schemaFailure
    ? applyDrop(published, documents, grounding)
    : [];
  return {
    preGateContent: JSON.stringify(preGate),
    publicContent: JSON.stringify(published),
    droppedIds,
    schemaFailure,
    parseFailure: false,
    grounding,
  };
}
