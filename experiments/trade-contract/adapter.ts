import { CHECK_IDS, CONTRACT_VERSION } from './contract.ts';
import type {
  Document, Evidence, EvaluationOptions, EvaluationResult, TradeContractInput,
} from './contract.ts';
import { documentDigest, evaluateTradeContract } from './evaluate.ts';
import { buildAdapterRequest } from './messages.ts';
import { MODEL_CONFIG, type CascadeFailure } from './model-config.ts';
import { uniqueQuoteSpan } from './spans.ts';

export { buildAdapterMessages, buildAdapterRequest, XAI_CHAT_COMPLETIONS_URL } from './messages.ts';
export { XAI_REQUEST_TIMEOUT_MS } from './model-config.ts';
export type { AdapterChatRequest, AdapterMessage, AdapterStage } from './messages.ts';

/** Local adapter id. It is not read from the model payload. */
export const ADAPTER_ID = 'trade-contract-adapter/v1';
export const ADAPTER_OUTPUT_VERSION = 'trade-contract-adapter/v1';

const OPTIONAL_CHECKS = ['mandate_compliance', 'numeric_limits', 'additional_claims'] as const;
const SEMANTIC_CHECKS = ['decision_basis', 'order_strategy_consistency', 'mandate_compliance'] as const;
const POSITION_KEYS = new Set(['start', 'end', 'offset', 'position']);

export type AdapterExchange =
  | { ok: true; content: string }
  | { ok: false; reason: 'timeout' | 'transport_error' | 'http_error' | 'empty' };

type Quote = { documentId: string; quote: string };
type Detection = { checkId: typeof OPTIONAL_CHECKS[number]; state: 'complete' | 'incomplete' | 'uncertain'; result: 'found' | 'none' };
type RequirementRow = { id: string; kind: 'strategy' | 'mandate'; decidedBy: string; quotes: Quote[] };
type SemanticRow = { checkId: typeof SEMANTIC_CHECKS[number]; status: TradeContractInput['semanticChecks'][number]['status']; quotes: Quote[]; requirementIds: string[] };
type ClaimRow = TradeContractInput['claims'][number] & { claimQuote: Quote; supportingQuotes: Quote[] };
type QuantityRow = {
  id: string; binding: TradeContractInput['quantities'][number]['binding']; value: string;
  numberReading: string; valueQuote: Quote; bindingQuotes: Quote[]; referenceQuote: Quote | null;
};
type LimitRow = QuantityRow & { operator: TradeContractInput['limits'][number]['operator']; quantityId: string | null };
type Parsed = {
  complete: boolean;
  applicability: TradeContractInput['applicability'];
  detection: Detection[];
  requirements: RequirementRow[];
  semanticChecks: SemanticRow[];
  claims: ClaimRow[];
  quantities: QuantityRow[];
  limits: LimitRow[];
};

function isPlain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function take(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isPlain(value)) return null;
  const present = Object.keys(value);
  if (present.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return null;
  return value;
}
function str(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}
function long(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2_000_000;
}
const oneOf = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value);

function stripPositionClaims(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPositionClaims);
  if (!isPlain(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !POSITION_KEYS.has(key))
    .map(([key, child]) => [key, stripPositionClaims(child)]));
}

function quote(value: unknown): Quote | null {
  const row = take(value, ['documentId', 'quote']);
  if (!row || !str(row.documentId) || !long(row.quote)) return null;
  const documentId = row.documentId;
  const text = row.quote;
  return { documentId, quote: text };
}
function quotes(value: unknown): Quote[] | null {
  if (!Array.isArray(value) || value.length > 1_024) return null;
  const rows = value.map(quote);
  if (rows.some(row => row === null)) return null;
  return rows as Quote[];
}

function parseOutput(content: string): { failure: CascadeFailure } | { value: Parsed } {
  if (content.trim() === '') return { failure: 'empty' };
  let raw: unknown;
  try {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(content.trim());
    raw = JSON.parse(fenced ? fenced[1] : content);
  } catch {
    return { failure: 'parse_error' };
  }
  raw = stripPositionClaims(raw);
  const root = take(raw, [
    'version', 'complete', 'applicability', 'detection', 'requirements',
    'semanticChecks', 'claims', 'quantities', 'limits',
  ]);
  if (!root || root.version !== ADAPTER_OUTPUT_VERSION || typeof root.complete !== 'boolean') {
    return { failure: 'schema_violation' };
  }
  if (!Array.isArray(root.applicability) || !Array.isArray(root.detection) || !Array.isArray(root.semanticChecks)
    || !Array.isArray(root.requirements) || !Array.isArray(root.claims)
    || !Array.isArray(root.quantities) || !Array.isArray(root.limits)) {
    return { failure: 'schema_violation' };
  }
  const applicability = root.applicability.map(item => {
    const row = take(item, ['checkId', 'status', 'basis', 'documentIds', 'complete']);
    if (!row || !oneOf(row.checkId, CHECK_IDS) || !oneOf(row.status, ['applicable', 'not_applicable', 'undetermined'])
      || !oneOf(row.basis, ['mandatory', 'explicit_items', 'none_in_complete_scope', 'undetermined'])
      || typeof row.complete !== 'boolean' || !Array.isArray(row.documentIds)
      || row.documentIds.some(id => !str(id))) return null;
    return row as unknown as TradeContractInput['applicability'][number];
  });
  const detection = root.detection.map(item => {
    const row = take(item, ['checkId', 'state', 'result']);
    if (!row || !oneOf(row.checkId, OPTIONAL_CHECKS) || !oneOf(row.state, ['complete', 'incomplete', 'uncertain'])
      || !oneOf(row.result, ['found', 'none'])) return null;
    return row as unknown as Detection;
  });
  const requirements = root.requirements.map(item => {
    const row = take(item, ['id', 'kind', 'sourceHeading', 'decidedBy', 'quotes']);
    if (!row || !str(row.id) || !oneOf(row.kind, ['strategy', 'mandate'])
      || !(row.sourceHeading === null || long(row.sourceHeading))
      || !oneOf(row.decidedBy, ['clause', 'section_heading', 'undetermined'])) return null;
    const parsedQuotes = quotes(row.quotes);
    if (!parsedQuotes) return null;
    return { id: row.id as string, kind: row.kind as 'strategy' | 'mandate', decidedBy: row.decidedBy as string, quotes: parsedQuotes };
  });
  const semanticChecks = root.semanticChecks.map(item => {
    const row = take(item, ['checkId', 'status', 'quotes', 'requirementIds']);
    if (!row || !oneOf(row.checkId, SEMANTIC_CHECKS)
      || !oneOf(row.status, ['fulfilled', 'contradicted', 'not_verifiable', 'not_applicable'])
      || !Array.isArray(row.requirementIds) || row.requirementIds.some(id => !str(id))) return null;
    const parsedQuotes = quotes(row.quotes);
    if (!parsedQuotes) return null;
    return {
      checkId: row.checkId as SemanticRow['checkId'],
      status: row.status as SemanticRow['status'],
      quotes: parsedQuotes,
      requirementIds: row.requirementIds as string[],
    };
  });
  const claims = root.claims.map(item => {
    const row = take(item, ['id', 'kind', 'status', 'claimQuote', 'supportingQuotes', 'calculation']);
    if (!row || !str(row.id) || !oneOf(row.kind, ['source_fact', 'inference', 'calculation', 'unsubstantiated_new_fact'])
      || !oneOf(row.status, ['fulfilled', 'contradicted', 'not_verifiable'])) return null;
    const claimQuote = quote(row.claimQuote);
    const supportingQuotes = quotes(row.supportingQuotes);
    if (!claimQuote || !supportingQuotes) return null;
    let calculation: ClaimRow['calculation'] = null;
    if (row.calculation !== null) {
      const formula = take(row.calculation, ['operation', 'leftId', 'rightId', 'resultId']);
      if (!formula || !oneOf(formula.operation, ['add', 'subtract'])
        || !str(formula.leftId) || !str(formula.rightId) || !str(formula.resultId)) return null;
      calculation = formula as unknown as ClaimRow['calculation'];
    }
    return {
      id: row.id as string, kind: row.kind as ClaimRow['kind'], status: row.status as ClaimRow['status'],
      claimQuote, supportingQuotes, calculation, claimEvidence: claimQuote as unknown as Evidence,
      supportingEvidence: [],
    };
  });
  const bindingOf = (value: unknown) => {
    const row = take(value, ['subjectId', 'measureId', 'unit', 'referenceId']);
    if (!row || !str(row.subjectId) || !str(row.measureId) || !str(row.unit) || !str(row.referenceId)) return null;
    return row as unknown as QuantityRow['binding'];
  };
  const quantityOf = (item: unknown, extra: readonly string[]) => {
    const row = take(item, ['id', 'binding', 'value', 'numberReading', 'valueQuote', 'bindingQuotes', 'referenceQuote', ...extra]);
    if (!row || !str(row.id) || !str(row.value) || !oneOf(row.numberReading, ['unambiguous', 'ambiguous', 'undetermined'])) return null;
    const binding = bindingOf(row.binding);
    const valueQuote = quote(row.valueQuote);
    const bindingQuotes = quotes(row.bindingQuotes);
    if (!binding || !valueQuote || !bindingQuotes) return null;
    let referenceQuote: Quote | null = null;
    if (row.referenceQuote !== null) {
      referenceQuote = quote(row.referenceQuote);
      if (!referenceQuote) return null;
    }
    return { row, binding, valueQuote, bindingQuotes, referenceQuote };
  };
  const quantities = root.quantities.map(item => {
    const parsed = quantityOf(item, []);
    if (!parsed) return null;
    return {
      id: parsed.row.id as string, binding: parsed.binding, value: parsed.row.value as string,
      numberReading: parsed.row.numberReading as string, valueQuote: parsed.valueQuote,
      bindingQuotes: parsed.bindingQuotes, referenceQuote: parsed.referenceQuote,
    };
  });
  const limits = root.limits.map(item => {
    const parsed = quantityOf(item, ['operator', 'quantityId']);
    if (!parsed || !oneOf(parsed.row.operator, ['<', '<=', '>', '>=', '=='])) return null;
    if (!(parsed.row.quantityId === null || str(parsed.row.quantityId))) return null;
    return {
      id: parsed.row.id as string, binding: parsed.binding, value: parsed.row.value as string,
      numberReading: parsed.row.numberReading as string, valueQuote: parsed.valueQuote,
      bindingQuotes: parsed.bindingQuotes, referenceQuote: parsed.referenceQuote,
      operator: parsed.row.operator as LimitRow['operator'], quantityId: parsed.row.quantityId as string | null,
    };
  });
  const rows = [applicability, detection, requirements, semanticChecks, claims, quantities, limits];
  if (rows.some(group => group.some(item => item === null))) return { failure: 'schema_violation' };
  const ids = (group: { checkId: string }[], expected: readonly string[]) =>
    group.length === expected.length && expected.every(id => group.filter(item => item.checkId === id).length === 1);
  if (!ids(applicability as { checkId: string }[], CHECK_IDS)
    || !ids(semanticChecks as { checkId: string }[], SEMANTIC_CHECKS)
    || !ids(detection as { checkId: string }[], OPTIONAL_CHECKS)) {
    return { failure: 'missing_checks' };
  }
  return {
    value: {
      complete: root.complete,
      applicability: applicability as Parsed['applicability'],
      detection: detection as Detection[],
      requirements: requirements as RequirementRow[],
      semanticChecks: semanticChecks as SemanticRow[],
      claims: claims as ClaimRow[],
      quantities: quantities as QuantityRow[],
      limits: limits as LimitRow[],
    },
  };
}

function locate(documents: readonly Document[], item: Quote): Evidence {
  const document = documents.find(document => document.id === item.documentId);
  const span = document ? uniqueQuoteSpan(document.text, item.quote) : null;
  if (!span) return { documentId: item.documentId, start: 0, end: 0, quote: item.quote };
  return { documentId: item.documentId, start: span.start, end: span.end, quote: item.quote };
}

function build(documents: readonly Document[], parsed: Parsed): { input: TradeContractInput; downgradeAllow: boolean } {
  let downgradeAllow = !parsed.complete;
  const itemCount = (checkId: Detection['checkId']) => checkId === 'mandate_compliance'
    ? parsed.requirements.filter(item => item.kind === 'mandate').length
    : checkId === 'additional_claims' ? parsed.claims.length : parsed.limits.length;
  for (const detection of parsed.detection) {
    const count = itemCount(detection.checkId);
    const applicability = parsed.applicability.find(item => item.checkId === detection.checkId);
    if (detection.state !== 'complete' || (detection.result === 'none') !== (count === 0)
      || (detection.result === 'none' && applicability?.status !== 'not_applicable')) {
      downgradeAllow = true;
    }
  }
  if (parsed.requirements.some(item => item.decidedBy !== 'clause')) downgradeAllow = true;
  if ([...parsed.quantities, ...parsed.limits].some(item => item.numberReading !== 'unambiguous')) downgradeAllow = true;
  const input: TradeContractInput = {
    version: CONTRACT_VERSION,
    documents: documents.map(document => ({ id: document.id, role: document.role, text: document.text })),
    adapter: {
      id: ADAPTER_ID,
      contractVersion: CONTRACT_VERSION,
      complete: parsed.complete,
      coverage: documents.map(document => ({ documentId: document.id, sha256: documentDigest(document.text) })),
    },
    applicability: parsed.applicability,
    requirements: parsed.requirements.map(item => ({
      id: item.id, kind: item.kind, evidence: item.quotes.map(item => locate(documents, item)),
    })),
    semanticChecks: parsed.semanticChecks.map(item => ({
      checkId: item.checkId, status: item.status, requirementIds: item.requirementIds,
      evidence: item.quotes.map(item => locate(documents, item)),
    })),
    claims: parsed.claims.map(item => ({
      id: item.id, kind: item.kind, status: item.status, calculation: item.calculation,
      claimEvidence: locate(documents, item.claimQuote),
      supportingEvidence: item.supportingQuotes.map(item => locate(documents, item)),
    })),
    quantities: parsed.quantities.map(item => ({
      id: item.id, binding: item.binding, value: item.value,
      valueEvidence: locate(documents, item.valueQuote),
      bindingEvidence: item.bindingQuotes.map(item => locate(documents, item)),
      referenceEvidence: item.referenceQuote ? locate(documents, item.referenceQuote) : null,
    })),
    limits: parsed.limits.map(item => ({
      id: item.id, binding: item.binding, operator: item.operator, value: item.value,
      valueEvidence: locate(documents, item.valueQuote),
      bindingEvidence: item.bindingQuotes.map(item => locate(documents, item)),
      referenceEvidence: item.referenceQuote ? locate(documents, item.referenceQuote) : null,
      quantityId: item.quantityId,
    })),
  };
  return { input, downgradeAllow };
}

function downgrade(result: EvaluationResult): EvaluationResult {
  if (result.decision !== 'ALLOW') return result;
  return {
    version: result.version,
    decision: 'UNCERTAIN',
    checks: result.checks.map(check => ({
      checkId: check.checkId,
      status: check.status === 'contradicted' ? 'contradicted' as const : 'not_verifiable' as const,
    })),
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
  };
}

function uncertain(options: EvaluationOptions): EvaluationResult {
  return evaluateTradeContract(undefined, options);
}

function inspect(documents: readonly Document[], exchange: AdapterExchange, options: EvaluationOptions):
  { failure: CascadeFailure; result: EvaluationResult } | { failure: null; result: EvaluationResult } {
  if (!exchange.ok) return { failure: exchange.reason, result: uncertain(options) };
  const parsed = parseOutput(exchange.content);
  if ('failure' in parsed) return { failure: parsed.failure, result: uncertain(options) };
  const built = build(documents, parsed.value);
  const result = evaluateTradeContract(built.input, options);
  return { failure: null, result: built.downgradeAllow ? downgrade(result) : result };
}

const SWIFT_VERDICTS = ['ALLOW', 'BLOCK', 'CONDITIONAL_ALLOW', 'HOLD', 'UNCERTAIN'] as const;
type SwiftVerdict = (typeof SWIFT_VERDICTS)[number];

function explicitVerdict(content: string): SwiftVerdict | null {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = (fenced ? fenced[1] : trimmed).trim();
  if ((SWIFT_VERDICTS as readonly string[]).includes(body)) return body as SwiftVerdict;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isPlain(parsed)) return null;
    const verdict = parsed.verdict ?? parsed.decision;
    if (typeof verdict === 'string' && (SWIFT_VERDICTS as readonly string[]).includes(verdict)) {
      return verdict as SwiftVerdict;
    }
  } catch {
    // Not JSON. A non-BLOCK label was already handled above.
  }
  return null;
}

function blockVerdict(): EvaluationResult {
  return {
    version: CONTRACT_VERSION,
    decision: 'BLOCK',
    checks: CHECK_IDS.map(checkId => ({ checkId, status: 'contradicted' })),
  };
}

/**
 * The secondary model is block-only. A contract BLOCK or an explicit BLOCK verdict stays
 * BLOCK. ALLOW, CONDITIONAL_ALLOW, HOLD, UNCERTAIN, and every other outcome
 * become UNCERTAIN. A failed exchange is UNCERTAIN.
 */
function publishSecondary(
  exchange: AdapterExchange,
  inspected: { failure: CascadeFailure | null; result: EvaluationResult },
  options: EvaluationOptions,
): EvaluationResult {
  if (MODEL_CONFIG.cascade.secondaryPolicy !== 'block_only') return uncertain(options);
  if (exchange.ok && !inspected.failure && inspected.result.decision === 'BLOCK'
    && MODEL_CONFIG.cascade.onSecondaryBlock === 'BLOCK') {
    return inspected.result;
  }
  if (exchange.ok && explicitVerdict(exchange.content) === 'BLOCK'
    && MODEL_CONFIG.cascade.onSecondaryBlock === 'BLOCK') {
    return blockVerdict();
  }
  return uncertain(options);
}

/**
 * Offline cascade. A schema-valid primary decision is final, including UNCERTAIN.
 * Only the pinned failure reasons consult the secondary exchange, once.
 * This function does not call a provider.
 */
export function decideCascade(
  documents: readonly Document[],
  primary: AdapterExchange,
  secondary: AdapterExchange | null,
  options: EvaluationOptions,
): EvaluationResult {
  try {
    // The same request the runner would send. Invalid documents cannot release.
    buildAdapterRequest(documents, 'primary');
  } catch {
    return uncertain(options);
  }
  const first = inspect(documents, primary, options);
  if (!first.failure) return first.result;
  const reasons: readonly string[] = MODEL_CONFIG.cascade.when;
  if (!reasons.includes(first.failure) || secondary === null) return uncertain(options);
  try {
    buildAdapterRequest(documents, 'secondary');
  } catch {
    return uncertain(options);
  }
  const second = inspect(documents, secondary, options);
  return publishSecondary(secondary, second, options);
}

export function decideExchange(
  documents: readonly Document[],
  exchange: AdapterExchange,
  options: EvaluationOptions,
): EvaluationResult {
  return decideCascade(documents, exchange, null, options);
}
