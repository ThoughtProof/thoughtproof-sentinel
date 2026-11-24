import { describe, expect, it } from 'vitest';
import type { Claim, Evidence, TradeContractInput } from './contract.ts';
import { DEVELOPMENT_ADAPTER, developmentFixture } from './development-fixture.ts';
import { checkExactCalculation, compareDecimal } from './decimal.ts';
import { documentDigest, evaluateTradeContract } from './evaluate.ts';

const options = { trustedAdapterIds: [DEVELOPMENT_ADAPTER] };
const evaluate = (input: unknown) => evaluateTradeContract(input, options);
const refresh = (input: TradeContractInput) => {
  input.adapter.coverage = input.documents.map(document => ({ documentId: document.id, sha256: documentDigest(document.text) }));
};
function ref(input: TradeContractInput, documentId: string, quote: string, from = 0): Evidence {
  const start = input.documents.find(document => document.id === documentId)!.text.indexOf(quote, from);
  if (start < 0) throw new Error('Broken development test fixture');
  return { documentId, start, end: start + quote.length, quote };
}
function replace(input: TradeContractInput, documentId: string, from: string, to: string): void {
  const document = input.documents.find(document => document.id === documentId)!;
  document.text = document.text.replaceAll(from, to);
  const visited = new WeakSet<object>();
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    const item = value as Record<string, unknown>;
    if (item.documentId === documentId && typeof item.quote === 'string') {
      const quote = item.quote.replaceAll(from, to);
      Object.assign(item, ref(input, documentId, quote));
    } else for (const child of Object.values(item)) visit(child);
  }
  visit(input);
  refresh(input);
}
function setApplicability(input: TradeContractInput, checkId: 'mandate_compliance' | 'numeric_limits' | 'additional_claims', applicable: boolean): void {
  Object.assign(input.applicability.find(item => item.checkId === checkId)!, {
    status: applicable ? 'applicable' : 'not_applicable',
    basis: applicable ? 'explicit_items' : 'none_in_complete_scope',
  });
}
function addClaim(input: TradeContractInput, kind: Claim['kind'], statement: string): Claim {
  input.documents[1].text += `${statement}\n`;
  refresh(input);
  setApplicability(input, 'additional_claims', true);
  const claim: Claim = {
    id: 'added-claim', kind, status: 'fulfilled', claimEvidence: ref(input, 'order', statement),
    supportingEvidence: [input.requirements[0].evidence[0]], calculation: null,
  };
  input.claims.push(claim);
  return claim;
}
function calculationFixture(result = '0.30'): TradeContractInput {
  const input = developmentFixture();
  const statement = `Risk components: 0.10 % plus 0.20 % totals ${result} %.`;
  const claim = addClaim(input, 'calculation', statement);
  const start = claim.claimEvidence.start;
  const binding = { subjectId: 'components', measureId: 'risk', unit: 'percent', referenceId: 'same-account-equity' };
  const numbers = [['left', '0.10', start], ['right', '0.20', start], ['result', result, start + statement.indexOf('totals')]] as const;
  const quantities = numbers.map(([id, value, position]) => ({
    id, value, binding: { ...binding }, valueEvidence: ref(input, 'order', value, position), bindingEvidence: [claim.claimEvidence],
  }));
  input.quantities.push(...quantities);
  claim.calculation = { operation: 'add', leftId: 'left', rightId: 'right', resultId: 'result' };
  claim.supportingEvidence = quantities.map(quantity => quantity.valueEvidence);
  return input;
}

describe('explicit offline contract', () => {
  it('reaches ALLOW with independent evidence, another language and no separate reasoning field', () => {
    const input = developmentFixture();
    const before = JSON.stringify(input);
    expect(evaluate(input)).toEqual({
      version: 'trade-contract/v1', decision: 'ALLOW', checks: [
        { checkId: 'decision_basis', status: 'fulfilled' },
        { checkId: 'order_strategy_consistency', status: 'fulfilled' },
        { checkId: 'mandate_compliance', status: 'fulfilled' },
        { checkId: 'additional_claims', status: 'not_applicable' },
        { checkId: 'numeric_limits', status: 'fulfilled' },
      ],
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('does not infer semantics from instrument, order type, language or headings', () => {
    const input = developmentFixture();
    replace(input, 'order', 'Limitorder', '訂單類型乙');
    replace(input, 'context', 'Strategy:', 'Θέση:');
    // This tests transport of an already supplied semantic judgment, not its accuracy.
    expect(evaluate(input).decision).toBe('ALLOW');
    input.semanticChecks[1].status = 'contradicted';
    expect(evaluate(input).decision).toBe('BLOCK');
  });

  it.each([null, [], 'model said yes', 1, NaN, {}, { version: 'other' }])('fails closed for malformed envelope %j', raw => {
    expect(evaluate(raw).decision).toBe('UNCERTAIN');
  });

  it.each([
    ['missing check', (input: any) => input.semanticChecks.pop()],
    ['duplicate check', (input: any) => input.semanticChecks.push(structuredClone(input.semanticChecks[0]))],
    ['conflicting duplicate', (input: any) => input.semanticChecks.push({ ...input.semanticChecks[0], status: 'contradicted' })],
    ['missing check id', (input: any) => delete input.semanticChecks[0].checkId],
    ['unknown check id', (input: any) => input.semanticChecks[0].checkId = 'guess'],
    ['unexpected field', (input: any) => input.semanticChecks[0].rawModelOutput = 'private'],
    ['unexpected root field', (input: any) => input.providerResponse = 'private'],
    ['missing quantity', (input: any) => input.quantities = []],
    ['duplicate quantity', (input: any) => input.quantities.push(structuredClone(input.quantities[0]))],
    ['duplicate limit', (input: any) => input.limits.push(structuredClone(input.limits[0]))],
    ['duplicate requirement', (input: any) => input.requirements.push(structuredClone(input.requirements[0]))],
    ['duplicate applicability', (input: any) => input.applicability.push(structuredClone(input.applicability[0]))],
    ['missing applicability', (input: any) => input.applicability.pop()],
    ['NaN offset', (input: any) => input.semanticChecks[0].evidence[0].start = NaN],
  ])('rejects %s without a false release', (_name, mutate) => {
    const input = developmentFixture(); mutate(input);
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });

  it('requires the adapter to be locally trusted, complete and bound to all original documents', () => {
    const input = developmentFixture();
    expect(evaluateTradeContract(input).decision).toBe('UNCERTAIN');
    expect(evaluateTradeContract(input, { trustedAdapterIds: ['someone-else'] }).decision).toBe('UNCERTAIN');
    input.adapter.complete = false;
    expect(evaluate(input).decision).toBe('UNCERTAIN');
    input.adapter.complete = true;
    input.documents[0].text += 'Changed source';
    expect(evaluate(input).decision).toBe('UNCERTAIN');
    refresh(input);
    input.adapter.coverage.pop();
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });

  it('cannot fulfill decision/strategy obligations using only the order itself', () => {
    const input = developmentFixture();
    input.documents = [input.documents[1]];
    input.requirements = []; input.limits = []; input.quantities = [];
    refresh(input);
    input.applicability.forEach(item => item.documentIds = ['order']);
    setApplicability(input, 'numeric_limits', false); setApplicability(input, 'mandate_compliance', false);
    input.semanticChecks[0].evidence = [input.semanticChecks[0].evidence[0]];
    input.semanticChecks[1].evidence = [input.semanticChecks[1].evidence[0]];
    input.semanticChecks[1].requirementIds = [];
    Object.assign(input.semanticChecks[2], { status: 'not_applicable', evidence: [], requirementIds: [] });
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });

  it('keeps an evidenced BLOCK when an unrelated check is missing, malformed or uncertain', () => {
    for (const mutate of [
      (input: any) => input.semanticChecks.shift(),
      (input: any) => input.semanticChecks[0].status = 'not_verifiable',
      (input: any) => input.semanticChecks[0].evidence[0] = { ...input.semanticChecks[0].evidence[0], quote: 'false quote' },
      (input: any) => input.quantities = undefined,
      (input: any) => input.applicability.shift(),
      (input: any) => input.semanticChecks.push(structuredClone(input.semanticChecks[0])),
    ]) {
      const input = developmentFixture();
      input.semanticChecks[2].status = 'contradicted';
      mutate(input);
      expect(evaluate(input).decision).toBe('BLOCK');
    }
  });

  it('keeps a numeric BLOCK when a different semantic step is missing', () => {
    const input = developmentFixture();
    replace(input, 'order', '0.20', '0.40'); input.quantities[0].value = '0.40';
    input.semanticChecks.shift();
    expect(evaluate(input).decision).toBe('BLOCK');
  });

  it('is invariant to order and cannot downgrade a proven contradiction with a later uncertain limit', () => {
    const input = developmentFixture();
    input.semanticChecks[0].status = 'not_verifiable';
    input.semanticChecks[2].status = 'contradicted';
    input.limits.push({ ...structuredClone(input.limits[0]), id: 'unbound-limit', quantityId: null });
    const expected = evaluate(input);
    input.semanticChecks.reverse(); input.applicability.reverse(); input.limits.reverse(); input.documents.reverse();
    expect(evaluate(input)).toEqual(expected);
    expect(expected.decision).toBe('BLOCK');
  });

  it.each(['documentId', 'position', 'text', 'empty', 'fractional'])('rejects incorrect evidence %s', mode => {
    const input = developmentFixture();
    const evidence = input.semanticChecks[0].evidence[0];
    if (mode === 'documentId') evidence.documentId = 'missing';
    if (mode === 'position') evidence.start += 1;
    if (mode === 'text') evidence.quote = 'A real-looking but invented quotation';
    if (mode === 'empty') { evidence.end = evidence.start; evidence.quote = ''; }
    if (mode === 'fractional') evidence.start = 0.5;
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });

  it('verifies original UTF-16 offsets without trimming or normalizing line endings', () => {
    const input = developmentFixture();
    replace(input, 'order', 'Verkaufe', '🧭\r\nVerkaufe');
    expect(evaluate(input).decision).toBe('ALLOW');
    input.semanticChecks[0].evidence[0].start += 1;
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });

  it.each(['context', 'order'])('rejects whitespace-only proof from %s', documentId => {
    const input = developmentFixture();
    input.semanticChecks[0].evidence = input.semanticChecks[0].evidence.map(evidence =>
      evidence.documentId === documentId ? ref(input, documentId, '\n') : evidence);
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });

  it('does not export quotes, document IDs or raw text, even in opt-in diagnostics', () => {
    const input = developmentFixture();
    input.semanticChecks[0].evidence[0].quote = 'PRIVATE_QUOTE_MARKER';
    const normal = evaluate(input);
    expect(normal).not.toHaveProperty('diagnostics');
    const diagnostic = evaluateTradeContract(input, { ...options, diagnostics: true });
    expect(diagnostic.diagnostics?.length).toBeGreaterThan(0);
    for (const output of [normal, diagnostic]) {
      expect(JSON.stringify(output)).not.toContain('PRIVATE_QUOTE_MARKER');
      expect(JSON.stringify(output)).not.toContain('Helio');
      expect(JSON.stringify(output)).not.toContain('invented-development-fixture');
    }
  });
});

describe('explicit applicability', () => {
  it('allows absent optional limits/mandates with complete applicability proof and no absence quotation', () => {
    const input = developmentFixture();
    input.requirements = input.requirements.filter(item => item.kind !== 'mandate');
    input.limits = [];
    input.documents[0].text = `${input.requirements[0].evidence[0].quote}\n`;
    refresh(input);
    setApplicability(input, 'numeric_limits', false); setApplicability(input, 'mandate_compliance', false);
    Object.assign(input.semanticChecks[2], { status: 'not_applicable', evidence: [], requirementIds: [] });
    expect(evaluate(input).decision).toBe('ALLOW');
  });

  it.each(['incomplete', 'missing-document', 'duplicate-document', 'mandatory-na', 'present-limit-na', 'present-mandate-na', 'unknown'])('rejects N/A misuse: %s', mode => {
    const input = developmentFixture();
    const claims = input.applicability.find(item => item.checkId === 'additional_claims')!;
    if (mode === 'incomplete') claims.complete = false;
    if (mode === 'missing-document') claims.documentIds.pop();
    if (mode === 'duplicate-document') claims.documentIds.push('order');
    if (mode === 'mandatory-na') Object.assign(input.applicability[0], { status: 'not_applicable', basis: 'none_in_complete_scope' });
    if (mode === 'present-limit-na') setApplicability(input, 'numeric_limits', false);
    if (mode === 'present-mandate-na') setApplicability(input, 'mandate_compliance', false);
    if (mode === 'unknown') Object.assign(claims, { status: 'undetermined', basis: 'undetermined' });
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });
});

describe('semantic claim categories and exact calculations', () => {
  it('permits a supported inference without requiring word-for-word repetition', () => {
    const input = developmentFixture();
    addClaim(input, 'inference', 'Reducing the holding follows the weaker-demand thesis.');
    expect(evaluate(input).decision).toBe('ALLOW');
  });
  it('rejects an inference that only cites itself', () => {
    const input = developmentFixture();
    const claim = addClaim(input, 'inference', 'This order is wise.');
    claim.supportingEvidence = [claim.claimEvidence];
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });
  it('blocks a referenced, semantically identified new unsupported fact', () => {
    const input = developmentFixture();
    const claim = addClaim(input, 'unsubstantiated_new_fact', 'A merger has been confirmed.');
    claim.status = 'contradicted'; claim.supportingEvidence = [];
    expect(evaluate(input).decision).toBe('BLOCK');
    claim.status = 'fulfilled';
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });
  it('does not let the presence of an additional claim pass as N/A', () => {
    const input = developmentFixture();
    addClaim(input, 'source_fact', 'Demand has weakened.');
    setApplicability(input, 'additional_claims', false);
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });
  it('allows a correct bound decimal calculation and blocks an incorrect one', () => {
    expect(evaluate(calculationFixture()).decision).toBe('ALLOW');
    expect(evaluate(calculationFixture('0.31')).decision).toBe('BLOCK');
  });
  it('treats correct arithmetic plus a contradictory semantic verdict as unresolved', () => {
    const input = calculationFixture(); input.claims[0].status = 'contradicted';
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });
  it.each(['missing-formula', 'missing-operand', 'different-unit', 'false-token', 'missing-result-evidence'])('does not guess a calculation: %s', mode => {
    const input = calculationFixture();
    if (mode === 'missing-formula') input.claims[0].calculation = null;
    if (mode === 'missing-operand') input.claims[0].calculation!.leftId = 'absent';
    if (mode === 'different-unit') input.quantities[1].binding.unit = 'EUR';
    if (mode === 'false-token') input.quantities[1].value = '0.11';
    if (mode === 'missing-result-evidence') input.claims[0].supportingEvidence.pop();
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });
});

describe('bound numeric checks', () => {
  it.each([
    ['<', '0.30', 'BLOCK'], ['<=', '0.30', 'ALLOW'], ['>', '0.30', 'BLOCK'],
    ['>=', '0.30', 'ALLOW'], ['==', '0.30', 'ALLOW'], ['<', '0.20', 'ALLOW'],
    ['<=', '0.40', 'BLOCK'], ['>', '0.40', 'ALLOW'], ['==', '0.20', 'BLOCK'],
  ] as const)('evaluates %s with quantity %s exactly', (operator, value, decision) => {
    const input = developmentFixture();
    replace(input, 'order', '0.20', value); input.quantities[0].value = value;
    replace(input, 'context', '<=', operator); input.limits[0].operator = operator;
    expect(evaluate(input).decision).toBe(decision);
  });
  it.each(['subjectId', 'measureId', 'unit', 'referenceId'] as const)('rejects incompatible binding %s', field => {
    const input = developmentFixture(); input.quantities[0].binding[field] = 'other';
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });
  it.each([null, 'missing'])('rejects missing/ambiguous quantity binding %s', id => {
    const input = developmentFixture(); input.limits[0].quantityId = id;
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });
  it('requires decimal value agreement with the exact cited token', () => {
    const input = developmentFixture(); input.quantities[0].value = '0.01';
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });
  it('rejects a random incidental number outside the binding evidence', () => {
    const input = developmentFixture();
    input.quantities[0].value = '10'; input.quantities[0].valueEvidence = ref(input, 'order', '10');
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });
  it('rejects using the same numeric token as both quantity and limit', () => {
    const input = developmentFixture();
    input.quantities[0].value = input.limits[0].value;
    input.quantities[0].valueEvidence = structuredClone(input.limits[0].valueEvidence);
    input.quantities[0].bindingEvidence = structuredClone(input.limits[0].bindingEvidence);
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });
  it.each(['−0.20', '− 0.20', '甲0.20', '𝒙0.20', '0.20β', '1 0.20', '0.20 123', '1\u202f0.20', '0.20e3', '0.20,5', '0.20_foo'])('rejects a decimal substring in unsupported text %s', token => {
    const input = developmentFixture();
    replace(input, 'order', '0.20', token);
    input.quantities[0].valueEvidence = ref(input, 'order', '0.20');
    expect(evaluate(input).decision).toBe('UNCERTAIN');
  });
  it('retains numeric BLOCK with a second unbound comparison in either order', () => {
    const input = developmentFixture();
    replace(input, 'order', '0.20', '0.40'); input.quantities[0].value = '0.40';
    input.limits.push({ ...structuredClone(input.limits[0]), id: 'other-limit', quantityId: null });
    expect(evaluate(input).decision).toBe('BLOCK');
    input.limits.reverse();
    expect(evaluate(input).decision).toBe('BLOCK');
  });
});

describe('decimal helper', () => {
  it('handles values beyond floating-point precision and exact decimal sums', () => {
    expect(compareDecimal('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareDecimal('0.1000000000000000001', '0.1000000000000000000')).toBe(1);
    expect(compareDecimal('-0.10', '-0.1')).toBe(0);
    expect(checkExactCalculation('add', '0.1', '0.2', '0.3')).toBe(true);
    expect(checkExactCalculation('subtract', '0.1', '0.2', '-0.1')).toBe(true);
  });
  it.each(['NaN', 'Infinity', '1e3', '1,000', '.1', '01', '−1', '', '9'.repeat(129)])('rejects unsupported decimal %s', value => {
    expect(compareDecimal(value, '1')).toBeNull();
  });
});
