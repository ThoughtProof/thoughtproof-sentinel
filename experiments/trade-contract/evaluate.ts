import { createHash } from 'node:crypto';
import { CHECK_IDS, CONTRACT_VERSION } from './contract.ts';
import type {
  Binding, CheckId, Claim, Evidence, EvaluationOptions,
  EvaluationResult, Quantity, SemanticCheck, Status, TradeContractInput,
} from './contract.ts';
import { checkExactCalculation, compareDecimal, readNumericToken } from './decimal.ts';
import { sentenceFinalPeriod, uniqueQuoteSpan } from './spans.ts';

type Issue = { code: string; path: string };
type Guard = (value: unknown, path: string, issues: Issue[]) => boolean;
const strings = (values: readonly string[]): Guard => value => typeof value === 'string' && values.includes(value);
const id: Guard = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const text: Guard = value => typeof value === 'string' && value.length <= 2_000_000;
const bool: Guard = value => typeof value === 'boolean';
const offset: Guard = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nullable = (guard: Guard): Guard => (value, path, issues) => value === null || guard(value, path, issues);
const array = (guard: Guard): Guard => (value, path, issues) => {
  if (!Array.isArray(value) || value.length > 1_024) return false;
  // Do not short-circuit: collect only fixed schema paths, never input values.
  return value.map((item, index) => guard(item, `${path}[${index}]`, issues)).every(Boolean);
};
const object = (fields: Record<string, Guard>): Guard => (value, path, issues) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(record))) return false;
  let valid = Object.keys(record).length === Object.keys(fields).length
    && Object.keys(record).every(key => Object.hasOwn(fields, key));
  for (const [key, guard] of Object.entries(fields)) {
    if (!Object.hasOwn(record, key) || !guard(record[key], `${path}.${key}`, issues)) {
      issues.push({ code: 'INVALID_FIELD', path: `${path}.${key}` });
      valid = false;
    }
  }
  if (!valid) issues.push({ code: 'INVALID_SHAPE', path });
  return valid;
};

const evidence = object({ documentId: id, start: offset, end: offset, quote: text });
const binding = object({ subjectId: id, measureId: id, unit: id, referenceId: id });
const statuses = ['fulfilled', 'contradicted', 'not_verifiable', 'not_applicable'] as const;
const fields = {
  version: strings([CONTRACT_VERSION]),
  documents: array(object({ id, role: strings(['proposal', 'source']), text })),
  adapter: object({
    id, contractVersion: strings([CONTRACT_VERSION]), complete: bool,
    coverage: array(object({ documentId: id, sha256: value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) })),
  }),
  applicability: array(object({
    checkId: strings(CHECK_IDS), status: strings(['applicable', 'not_applicable', 'undetermined']),
    basis: strings(['mandatory', 'explicit_items', 'none_in_complete_scope', 'undetermined']),
    documentIds: array(id), complete: bool,
  })),
  requirements: array(object({ id, kind: strings(['strategy', 'mandate']), evidence: array(evidence) })),
  semanticChecks: array(object({
    checkId: strings(['decision_basis', 'order_strategy_consistency', 'mandate_compliance']),
    status: strings(statuses), evidence: array(evidence), requirementIds: array(id),
  })),
  claims: array(object({
    id, kind: strings(['source_fact', 'inference', 'calculation', 'unsubstantiated_new_fact']),
    status: strings(['fulfilled', 'contradicted', 'not_verifiable']),
    claimEvidence: evidence, supportingEvidence: array(evidence),
    calculation: nullable(object({ operation: strings(['add', 'subtract']), leftId: id, rightId: id, resultId: id })),
  })),
  quantities: array(object({
    id, binding, value: id, valueEvidence: evidence, bindingEvidence: array(evidence),
    referenceEvidence: nullable(evidence),
  })),
  limits: array(object({
    id, binding, operator: strings(['<', '<=', '>', '>=', '==']), value: id,
    valueEvidence: evidence, bindingEvidence: array(evidence),
    referenceEvidence: nullable(evidence), quantityId: nullable(id),
  })),
} satisfies Record<keyof TradeContractInput, Guard>;

export function documentDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
const sameSet = (left: readonly string[], right: readonly string[]) =>
  new Set(left).size === left.length && left.length === right.length && right.every(value => left.includes(value));
const sameBinding = (left: Binding, right: Binding) =>
  left.subjectId === right.subjectId && left.measureId === right.measureId
  && left.unit === right.unit && left.referenceId === right.referenceId;
const sameEvidence = (a: Evidence, b: Evidence) => a.documentId === b.documentId
  && a.start === b.start && a.end === b.end && a.quote === b.quote;
const overlaps = (a: Evidence, b: Evidence) => a.documentId === b.documentId && a.start < b.end && b.start < a.end;
const aggregate = (statuses: Status[]): Status => {
  if (statuses.includes('contradicted')) return 'contradicted';
  if (statuses.length === 0 || statuses.includes('not_verifiable')) return 'not_verifiable';
  return statuses.every(status => status === 'not_applicable') ? 'not_applicable' : 'fulfilled';
};

/** Unknown input is validated before any verdict is trusted. No network, model or I/O. */
export function evaluateTradeContract(
  raw: unknown, options: EvaluationOptions = { trustedAdapterIds: [] },
): EvaluationResult {
  const issues: Issue[] = [];
  let invalidStructure = false;
  const issue = (code: string, path: string) => { issues.push({ code, path }); };
  const finish = (checks: EvaluationResult['checks']): EvaluationResult => ({
    version: CONTRACT_VERSION,
    decision: checks.some(check => check.status === 'contradicted') ? 'BLOCK'
      : invalidStructure || checks.some(check => check.status === 'not_verifiable') ? 'UNCERTAIN' : 'ALLOW',
    checks,
    ...(options?.diagnostics === true ? { diagnostics: issues } : {}),
  });
  const uncertain = () => finish(CHECK_IDS.map(checkId => ({ checkId, status: 'not_verifiable' })));
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) {
      issue('INVALID_SHAPE', '$'); return uncertain();
    }
    const record = raw as Record<string, unknown>;
    // Document/version/adapter corruption invalidates the trust foundation globally.
    if (!(['version', 'documents', 'adapter'] as const).map(key => {
      const valid = Object.hasOwn(record, key) && fields[key](record[key], `$.${key}`, issues);
      if (!valid) issue('INVALID_FIELD', `$.${key}`);
      return valid;
    }).every(Boolean)) return uncertain();
    if (Object.keys(record).some(key => !Object.hasOwn(fields, key))) {
      issue('UNEXPECTED_FIELD', '$'); invalidStructure = true;
    }
    const groupValid: Record<string, boolean> = {};
    // A malformed or duplicate row cannot erase a contradiction in another check.
    const rows = <K extends 'applicability' | 'requirements' | 'semanticChecks' | 'claims' | 'quantities' | 'limits'>(key: K): TradeContractInput[K] => {
      const value = Object.hasOwn(record, key) ? record[key] : undefined;
      groupValid[key] = true;
      if (!Array.isArray(value) || value.length > 1_024) {
        issue('INVALID_FIELD', `$.${key}`); invalidStructure = true; groupValid[key] = false;
        return [] as unknown as TradeContractInput[K];
      }
      const valid = value.filter((item, index) => {
        const local: Issue[] = [];
        const ok = fields[key]([item], `$.${key}`, local);
        if (!ok) {
          invalidStructure = true; groupValid[key] = false;
          issue('INVALID_FIELD', `$.${key}[${index}]`);
          for (const detail of local) issues.push({ ...detail, path: detail.path.replace(`[0]`, `[${index}]`) });
        }
        return ok;
      }) as Record<string, unknown>[];
      const identifier = key === 'applicability' || key === 'semanticChecks' ? 'checkId' : 'id';
      return valid.filter(item => {
        if (valid.filter(other => other[identifier] === item[identifier]).length === 1) return true;
        issue('DUPLICATE_ID', `$.${key}`); invalidStructure = true; groupValid[key] = false;
        return false;
      }) as unknown as TradeContractInput[K];
    };
    const input: TradeContractInput = {
      version: record.version as TradeContractInput['version'],
      documents: record.documents as TradeContractInput['documents'],
      adapter: record.adapter as TradeContractInput['adapter'],
      applicability: rows('applicability'), requirements: rows('requirements'), semanticChecks: rows('semanticChecks'),
      claims: rows('claims'), quantities: rows('quantities'), limits: rows('limits'),
    };
    if (new Set(input.documents.map(item => item.id)).size !== input.documents.length
      || new Set(input.adapter.coverage.map(item => item.documentId)).size !== input.adapter.coverage.length
      || input.documents.filter(item => item.role === 'proposal').length !== 1) {
      issue('INVALID_DOCUMENT_MANIFEST', '$.documents'); return uncertain();
    }
    if (!sameSet(input.applicability.map(item => item.checkId), CHECK_IDS)) {
      issue('CHECK_SET_MISMATCH', '$.applicability'); invalidStructure = true;
    }
    if (!sameSet(input.semanticChecks.map(item => item.checkId), ['decision_basis', 'order_strategy_consistency', 'mandate_compliance'])) {
      issue('CHECK_SET_MISMATCH', '$.semanticChecks'); invalidStructure = true;
    }

    const documents = new Map(input.documents.map(document => [document.id, document]));
    const documentIds = input.documents.map(document => document.id);
    if (!Array.isArray(options.trustedAdapterIds) || !options.trustedAdapterIds.includes(input.adapter.id)
      || !input.adapter.complete || !sameSet(input.adapter.coverage.map(item => item.documentId), documentIds)
      || input.adapter.coverage.some(item => item.sha256 !== documentDigest(documents.get(item.documentId)!.text))) {
      issue('UNTRUSTED_OR_INCOMPLETE_ADAPTER', '$.adapter');
      return uncertain();
    }

    const validEvidence = (ref: Evidence): boolean => {
      const document = documents.get(ref.documentId);
      if (!document || ref.quote.trim().length === 0) return false;
      // Positions come from an exact unique match, not from a claimed slice alone.
      const span = uniqueQuoteSpan(document.text, ref.quote);
      return !!span && ref.start === span.start && ref.end === span.end;
    };
    const evidenceList = (refs: Evidence[]) => refs.length > 0 && refs.every(validEvidence);
    const proposalEvidence = (ref: Evidence) => validEvidence(ref) && documents.get(ref.documentId)!.role === 'proposal';
    const sourceEvidence = (ref: Evidence) => validEvidence(ref) && documents.get(ref.documentId)!.role === 'source';
    const headingOnly = (quote: string) => /^(?:strategy|strategie|mandate|mandat|limits?|grenzen|obergrenze|maximum|minimum)\s*:?\s*$/i.test(quote.trim());
    const numericBoundary = (original: string, start: number, end: number): boolean => {
      const before = original.slice(0, start);
      const after = original.slice(end);
      const adjacent = /[\p{L}\p{N}\p{M}\p{Pc}.,+\-\u2212\u2010-\u2015\uFE63\uFF0D\u00a0\u202f']/u;
      const beforeChar = [...before].at(-1) ?? '';
      if (adjacent.test(beforeChar)) return false;
      if (/[\p{N}+\-\u2212\u2010-\u2015\uFE63\uFF0D][ \t\u00a0\u202f]+$/u.test(before)) return false;
      const afterChar = [...after][0] ?? '';
      // A sentence-ending period is not part of the number. A period before
      // another digit still glues, so `70` does not match inside `70.5`.
      if (!(afterChar === '.' && sentenceFinalPeriod(after)) && adjacent.test(afterChar)) return false;
      return !/^[ \t\u00a0\u202f]+\p{N}/u.test(after);
    };
    const percentMarked = (original: string, end: number, binding: Evidence[]): boolean => {
      const after = original.slice(end, end + 32);
      return /^[ \t\u00a0\u202f]?%/.test(original.slice(end))
        || /^[ \t\u00a0\u202f]*(?:percent|prozent)\b/i.test(after)
        || binding.some(item => /%|\bpercent\b|\bprozent\b/i.test(item.quote));
    };
    const tokenAgrees = (value: string, ref: Evidence, unit: string, binding: Evidence[]): boolean => {
      if (!validEvidence(ref)) return false;
      const original = documents.get(ref.documentId)!.text;
      if (!numericBoundary(original, ref.start, ref.end)) return false;
      const reading = readNumericToken(ref.quote);
      if (reading.status !== 'exact' || compareDecimal(value, reading.canonical) !== 0) return false;
      const suffixed = reading.percent || /^[ \t\u00a0\u202f]?%/.test(original.slice(ref.end));
      if (unit === 'percent') return suffixed || percentMarked(original, ref.end, binding);
      return !suffixed;
    };
    const substantiveReference = (quote: string): boolean => {
      const compact = quote.trim().replace(/\s+/g, ' ');
      if (/^(?:%|percent|per cent|prozent|pct)$/i.test(compact)) return false;
      const residue = compact
        .replace(/%|\bpercent\b|\bper cent\b|\bprozent\b|\bpct\b/ig, '')
        .replace(/[0-9.,+\-\s]/g, '');
      return [...residue].length >= 3 && /\p{L}/u.test(residue);
    };
    const competingReference = (quote: string) =>
      /\b(?:of|von|des|der|vom)\b[\s\S]{0,80}\b(?:or|oder)\b[\s\S]{0,40}\b(?:of|von|des|der|vom)\b/i.test(quote);
    const referenceBound = (unit: string, reference: Evidence | null, binding: Evidence[], value: Evidence): boolean => {
      if (unit !== 'percent') return reference === null;
      if (!reference || !validEvidence(reference) || sameEvidence(reference, value)) return false;
      if (!substantiveReference(reference.quote) || !containsValue(reference, binding)) return false;
      return !binding.some(item => competingReference(item.quote));
    };
    const containsValue = (value: Evidence, refs: Evidence[]) => refs.some(ref => ref.documentId === value.documentId
      && ref.start <= value.start && ref.end >= value.end);
    const validQuantity = (quantity: Quantity) =>
      tokenAgrees(quantity.value, quantity.valueEvidence, quantity.binding.unit, quantity.bindingEvidence)
      && evidenceList(quantity.bindingEvidence)
      && quantity.bindingEvidence.every(item => !headingOnly(item.quote))
      && containsValue(quantity.valueEvidence, quantity.bindingEvidence)
      && referenceBound(quantity.binding.unit, quantity.referenceEvidence, quantity.bindingEvidence, quantity.valueEvidence);
    const quantities = new Map(input.quantities.map(quantity => [quantity.id, quantity]));

    const applicability = (checkId: CheckId, count: number): Status | null => {
      const item = input.applicability.find(item => item.checkId === checkId);
      if (!item) return 'not_verifiable';
      const mandatory = checkId === 'decision_basis' || checkId === 'order_strategy_consistency';
      if (!item.complete || !sameSet(item.documentIds, documentIds)) {
        issue('INCOMPLETE_APPLICABILITY', `$.applicability[${input.applicability.indexOf(item)}]`);
        return 'not_verifiable';
      }
      if (item.status === 'not_applicable' && !mandatory && count === 0 && item.basis === 'none_in_complete_scope') {
        return 'not_applicable';
      }
      if (item.status === 'applicable' && item.basis === (mandatory ? 'mandatory' : 'explicit_items')
        && (mandatory || count > 0)) return null;
      issue('APPLICABILITY_CONFLICT', `$.applicability[${input.applicability.indexOf(item)}]`);
      return 'not_verifiable';
    };

    const semantic = (check: SemanticCheck): Status => {
      const index = input.semanticChecks.indexOf(check);
      if (!groupValid.requirements && check.checkId !== 'decision_basis') return 'not_verifiable';
      const requirements = input.requirements.filter(item =>
        check.checkId === 'order_strategy_consistency' ? item.kind === 'strategy'
          : check.checkId === 'mandate_compliance' ? item.kind === 'mandate' : false);
      const applicable = applicability(check.checkId, requirements.length);
      if (!sameSet(check.requirementIds, requirements.map(item => item.id))) {
        issue('REQUIREMENT_SET_MISMATCH', `$.semanticChecks[${index}]`);
        return 'not_verifiable';
      }
      if (applicable === 'not_applicable') {
        if (check.status === 'not_applicable' && check.evidence.length === 0) return 'not_applicable';
        issue('NA_FINDING_CONFLICT', `$.semanticChecks[${index}]`);
        return 'not_verifiable';
      }
      if (applicable !== null) return applicable;
      if (check.status === 'not_applicable' || check.status === 'not_verifiable') return 'not_verifiable';
      if (!evidenceList(check.evidence) || !check.evidence.some(proposalEvidence)
        || (check.status === 'fulfilled' && !check.evidence.some(sourceEvidence))
        || requirements.some(requirement => !evidenceList(requirement.evidence)
          || requirement.evidence.some(ref => headingOnly(ref.quote))
          || !requirement.evidence.every(sourceEvidence)
          || !requirement.evidence.some(ref => check.evidence.some(cited => sameEvidence(ref, cited))))) {
        issue('INVALID_SEMANTIC_EVIDENCE', `$.semanticChecks[${index}]`);
        return 'not_verifiable';
      }
      return check.status;
    };

    const claimStatus = (claim: Claim, index: number): Status => {
      const path = `$.claims[${index}]`;
      if (!proposalEvidence(claim.claimEvidence) || !claim.supportingEvidence.every(validEvidence)) {
        issue('INVALID_CLAIM_EVIDENCE', path);
        return 'not_verifiable';
      }
      if (claim.status === 'not_verifiable') return 'not_verifiable';
      if (claim.kind === 'unsubstantiated_new_fact') {
        if (claim.status === 'contradicted' && claim.calculation === null) return 'contradicted';
        issue('CLAIM_KIND_CONFLICT', path);
        return 'not_verifiable';
      }
      if (!evidenceList(claim.supportingEvidence)
        || ((claim.kind === 'source_fact' || claim.kind === 'inference') && !claim.supportingEvidence.some(sourceEvidence))) {
        issue('MISSING_CLAIM_SUPPORT', path);
        return 'not_verifiable';
      }
      if (claim.kind !== 'calculation') {
        if (claim.calculation !== null) { issue('CLAIM_KIND_CONFLICT', path); return 'not_verifiable'; }
        return claim.status;
      }
      const formula = claim.calculation;
      if (!formula) { issue('MISSING_CALCULATION', path); return 'not_verifiable'; }
      const left = quantities.get(formula.leftId), right = quantities.get(formula.rightId), result = quantities.get(formula.resultId);
      if (!left || !right || !result || ![left, right, result].every(validQuantity)
        || !sameBinding(left.binding, right.binding) || !sameBinding(left.binding, result.binding)
        || overlaps(result.valueEvidence, left.valueEvidence) || overlaps(result.valueEvidence, right.valueEvidence)
        || ![left, right, result].every(quantity => claim.supportingEvidence.some(ref => sameEvidence(ref, quantity.valueEvidence)))) {
        issue('UNBOUND_CALCULATION', path);
        return 'not_verifiable';
      }
      const correct = checkExactCalculation(formula.operation, left.value, right.value, result.value);
      if (correct && claim.status === 'contradicted') { issue('CALCULATION_VERDICT_CONFLICT', path); return 'not_verifiable'; }
      return correct === null ? 'not_verifiable' : correct ? 'fulfilled' : 'contradicted';
    };

    const hasBoundComparison = (quote: string) => /\d/.test(quote) && (
      /<=|>=|<|>|==/.test(quote)
      || /\b(?:unter|ueber|über|below|under|above|over|at most|at least|hoechstens|höchstens|mindestens|maximal|maximum|minimum|obergrenze)\b/i.test(quote)
    );
    const embeddedLimitsCovered = (): boolean => {
      const clauses = input.requirements.flatMap(requirement => requirement.evidence.filter(evidence =>
        validEvidence(evidence) && hasBoundComparison(evidence.quote)));
      return clauses.every(clause => input.limits.some(limit =>
        limit.valueEvidence.documentId === clause.documentId
        && clause.start <= limit.valueEvidence.start && limit.valueEvidence.end <= clause.end));
    };
    const numeric = (): Status => {
      const applicable = applicability('numeric_limits', input.limits.length || (groupValid.limits ? 0 : 1));
      const covered = embeddedLimitsCovered();
      // A section heading cannot hide a comparison that was quoted as a requirement.
      if (applicable === 'not_applicable') {
        if (!covered) { issue('UNBOUND_EMBEDDED_LIMIT', '$.limits'); return 'not_verifiable'; }
        return 'not_applicable';
      }
      if (applicable !== null) return applicable;
      if (!covered) issue('UNBOUND_EMBEDDED_LIMIT', '$.limits');
      return aggregate(input.limits.map((limit, index): Status => {
        const quantity = limit.quantityId === null ? undefined : quantities.get(limit.quantityId);
        if (!quantity || !validQuantity(quantity) || !tokenAgrees(limit.value, limit.valueEvidence, limit.binding.unit, limit.bindingEvidence)
          || !evidenceList(limit.bindingEvidence) || limit.bindingEvidence.some(item => headingOnly(item.quote))
          || !containsValue(limit.valueEvidence, limit.bindingEvidence)
          || !referenceBound(limit.binding.unit, limit.referenceEvidence, limit.bindingEvidence, limit.valueEvidence)
          || !sameBinding(quantity.binding, limit.binding)
          || overlaps(quantity.valueEvidence, limit.valueEvidence)) {
          issue('UNBOUND_NUMERIC_COMPARISON', `$.limits[${index}]`);
          return 'not_verifiable';
        }
        const comparison = compareDecimal(quantity.value, limit.value);
        if (comparison === null) return 'not_verifiable';
        const fulfilled = limit.operator === '<' ? comparison < 0
          : limit.operator === '<=' ? comparison <= 0
            : limit.operator === '>' ? comparison > 0
              : limit.operator === '>=' ? comparison >= 0 : comparison === 0;
        return fulfilled ? 'fulfilled' : 'contradicted';
      }).concat(groupValid.limits && groupValid.quantities && covered ? [] : ['not_verifiable']));
    };

    const results = new Map<CheckId, Status>();
    for (const check of input.semanticChecks) results.set(check.checkId, semantic(check));
    results.set('additional_claims', applicability('additional_claims', input.claims.length || (groupValid.claims ? 0 : 1))
      ?? aggregate(input.claims.map(claimStatus).concat(groupValid.claims ? [] : ['not_verifiable'])));
    results.set('numeric_limits', numeric());
    return finish(CHECK_IDS.map(checkId => ({ checkId, status: results.get(checkId) ?? 'not_verifiable' })));
  } catch {
    // Malformed JavaScript values (e.g. throwing getters) cannot create a release.
    issue('INVALID_INPUT', '$');
    return uncertain();
  }
}
