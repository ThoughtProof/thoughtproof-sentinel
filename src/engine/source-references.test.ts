import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.hoisted(() => {
  process.env.SERV_API_KEY = 'offline-fixture-only';
  process.env.SERV_BASE_URL = 'https://offline.invalid/v1';
});
import {evaluateItem, type EvalInput} from 'pot-cli/plv';
import {verify} from './index.js';
import {getModeHandler} from './modes/index.js';
import type {SentinelVerifyRequest} from '../types.js';

const positive: SentinelVerifyRequest = JSON.parse(readFileSync(
  new URL('./fixtures/cycle-quotes-20261017/supported_control_request.json', import.meta.url), 'utf8'));
const sourceLines = positive.evidence.split('\n').filter(line => /^Pre-decision reasoning [123]:/.test(line));
const marker = '\n\nHOST_SOURCE_REFERENCE_CATALOG_JSON\n';
const schemaMarker = '\n\nHOST_ASSESSMENT_OUTPUT_SCHEMA_JSON\n';
type Catalog = {allowed_sources: Record<string, 'trace' | 'answer'>; truncated: boolean;
  passages: Array<{ref: string; source: 'trace' | 'answer'; text: string}>};
let reply: (catalog: Catalog | null, body: any, call: number) => unknown;
let calls: any[];
beforeEach(() => {
  calls = [];
  vi.stubEnv('CONFIRM_BLOCKS', '0');
  reply = () => { throw Error('UNPLANNED_SYNTHETIC_COMPLETION'); };
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    expect(String(url)).toBe('https://offline.invalid/v1/chat/completions');
    const body = JSON.parse(String(options?.body));
    calls.push(body);
    const user = body.messages.find((m: any) => m.role === 'user').content;
    const catalog = user.includes(marker) ? JSON.parse(user.slice(user.lastIndexOf(marker) + marker.length).split(schemaMarker)[0]) : null;
    return new Response(JSON.stringify({choices: [{message: {content: JSON.stringify(reply(catalog, body, calls.length))}}]}));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function rows(catalog: Catalog, texts = sourceLines, score = 1) {
  return texts.map((text, i) => ({step_id: `step_${i}`, score,
    reasoning: 'Synthetic reviewer assessed the supplied statement under the unchanged criterion.',
    quote: null as string | null, quote_ref: catalog.passages.find(p => p.text === text)!.ref}));
}
const contract = (result: Awaited<ReturnType<typeof verify>>) => result.meta.verifier_trace!.stages[0].output_contract!;

describe('host-addressed citations through the installed router, parser and engine', () => {
  it('resolves only explicit selections into exact source quotes before provenance and floors', async () => {
    const before = JSON.stringify(positive);
    reply = catalog => rows(catalog!);
    const result = await verify(positive);
    expect(result.verdict).toBe('ALLOW');
    expect(result.objections.map(o => o.quote)).toEqual(sourceLines);
    expect(contract(result).source_references!.citations.map(c => c.status)).toEqual(['resolved', 'resolved', 'resolved']);
    for (const citation of contract(result).source_references!.citations) {
      expect(citation.source).toBe('trace');
      expect(citation.source_sha256).toBe(createHash('sha256').update(positive.evidence).digest('hex'));
      expect(positive.evidence.slice(citation.start!, citation.end!)).toBe(result.objections.find(o => o.step_id === citation.step_id)!.quote);
    }
    expect(result.meta.verifier_trace!.stages[0].objections.every(o => o.quote_diagnostics!.evaluator_match_path === 'exact')).toBe(true);
    expect(JSON.stringify(positive)).toBe(before);
    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].content).toContain('not an exemption from the scoring rubric');
    expect(calls[0].messages[1].content).toContain(positive.evidence);
    const schema = JSON.parse(calls[0].messages[1].content.split(schemaMarker)[1].split('\n\n')[0]);
    expect(schema.items.required).toEqual(['step_id', 'score', 'reasoning', 'quote', 'quote_ref']);
    expect(schema.items.properties.step_id.enum).toEqual(['step_0', 'step_1', 'step_2']);
    expect(schema.minItems).toBe(3);
    expect(calls[0].messages[1].content).toContain('Use reasoning, never assessment');
    expect(calls[0].messages[1].content.endsWith('output only JSON.')).toBe(true);
  });

  it.each(['unknown', 'stale_source', 'object', 'number', 'conflicting_text', 'omitted_quote'])('rejects %s without repairing or retrying the assessment', async variant => {
    const privateRef = 'PRIVATE_MODEL_REFERENCE_NOT_IN_THE_CATALOG';
    reply = catalog => {
      const data: any[] = rows(catalog!);
      if (variant === 'unknown') data[0].quote_ref = privateRef;
      if (variant === 'stale_source') data[0].quote_ref = 'T1_000000000000';
      if (variant === 'object') data[0].quote_ref = {ref: data[0].quote_ref};
      if (variant === 'number') data[0].quote_ref = 1;
      if (variant === 'conflicting_text') data[0].quote = sourceLines[1];
      if (variant === 'omitted_quote') delete data[0].quote;
      return data;
    };
    const result = await verify(positive);
    expect(result.verdict).toBe('UNCERTAIN');
    expect(result.confidence).toBe(0);
    expect(result.objections).toEqual([]);
    expect(contract(result).status).toBe('invalid');
    expect(contract(result).issues.map(i => i.code)).toContain(variant === 'omitted_quote' ? 'invalid_quote' : 'invalid_quote_reference');
    expect(JSON.stringify(result)).not.toContain(privateRef);
    expect(calls).toHaveLength(1);
  });

  it('rejects an actual reference from an earlier, changed source', async () => {
    let previous = '';
    reply = catalog => { const data = rows(catalog!); previous = data[0].quote_ref; return data; };
    await verify(positive);
    reply = catalog => { const data = rows(catalog!); data[0].quote_ref = previous; return data; };
    const result = await verify({...positive, evidence: positive.evidence + '\nA new observation was added.'});
    expect(result.verdict).toBe('UNCERTAIN');
    expect(contract(result).issues[0].code).toBe('invalid_quote_reference');
  });

  it.each([null, undefined])('never selects a citation for the model when quote_ref is %s', async ref => {
    reply = catalog => rows(catalog!).map(row => ({...row, quote_ref: ref}));
    const result = await verify(positive);
    expect(result.verdict).toBe('UNCERTAIN');
    expect(result.objections.every(o => o.quote === null && o.score <= 0.25)).toBe(true);
    expect(contract(result).source_references!.citations.every(c => c.status === 'none')).toBe(true);
  });

  it.each([0, 0.25])('a valid citation never lifts a restrictive score of %s', async score => {
    reply = catalog => rows(catalog!, sourceLines, score);
    const result = await verify(positive);
    expect(result.verdict).not.toBe('ALLOW');
    expect(result.objections.every(o => o.score === score)).toBe(true);
    expect(contract(result).source_references!.citations.every(c => c.status === 'resolved')).toBe(true);
  });

  it('preserves a cited contradiction as BLOCK', async () => {
    const risk: SentinelVerifyRequest = JSON.parse(readFileSync(new URL('./fixtures/cycle-quotes-20261017/risk_contradiction_request.json', import.meta.url), 'utf8'));
    const text = risk.evidence.split('\n').find(line => line.includes('The proposal claim incorrectly says stop 1900 and loss 50.'))!;
    expect(text).toBeTruthy();
    reply = catalog => rows(catalog!, [text, text, text], 0).map(row => ({...row, reasoning: 'The proposed stop contradicts the actual order facts.'}));
    const result = await verify(risk);
    expect(result.verdict).toBe('BLOCK');
    expect(result.objections.every(o => o.quote === text && o.score === 0)).toBe(true);
  });

  it('does not promote malformed primary references after secondary ALLOW', async () => {
    reply = (catalog, _body, call) => rows(catalog!).map((row, i) => call === 1 && i === 0 ? {...row, quote_ref: 'unknown'} : row);
    const result = await verify({...positive, tier: 'standard'});
    expect(result.verdict).toBe('UNCERTAIN');
    expect(result.meta.verifier_trace!.stages[0].output_contract!.status).toBe('invalid');
    expect(result.meta.verifier_trace!.stages[1].verdict).toBe('ALLOW');
    expect(calls).toHaveLength(2);
  });
});

describe('source scope, limits and unchanged caller behavior', () => {
  const mixed = (): EvalInput => ({id: 'mixed-sources', question: 'Preserve source routing.',
    answer: 'The final answer retains the two observed errors.',
    trace_steps: 'The experiment observed eighteen correct fields and two errors.',
    gold_plan_steps: [
      {index: 0, description: 'Retain observed errors.', criticality: 'critical'},
      {index: 1, description: 'Do not distort the answer.', criticality: 'critical', step_type: 'answer_consistency'},
    ]});
  const assess = (input: EvalInput, sourceReferences = true, strictOutputContract = true) => evaluateItem(input, 'serv-nano', {
    mode: 'support', sourceReferences, strictOutputContract,
  });

  it('routes trace and answer references to the same per-step sources as provenance', async () => {
    const input = mixed();
    reply = catalog => rows(catalog!, [input.trace_steps, input.answer]);
    const result = await assess(input);
    expect(result.verdict).toBe('ALLOW');
    expect(result.output_contract!.source_references!.citations.map(c => c.source)).toEqual(['trace', 'answer']);
  });

  it('rejects a valid address from the wrong evidence source', async () => {
    const input = mixed();
    reply = catalog => rows(catalog!, [input.answer, input.trace_steps]);
    const result = await assess(input);
    expect(result.verdict).toBe('HOLD');
    expect(result.step_evaluations).toEqual([]);
    expect(result.output_contract!.issues.map(i => i.code)).toEqual(['invalid_quote_reference', 'invalid_quote_reference']);
  });

  it('keeps Unicode, CRLF and indentation source coordinates exact and overrides model locations', async () => {
    const text = 'Observed 📈 values are 1980 → 1990 → 2000, before the proposed action.';
    const input = {...mixed(), trace_steps: '\r\n  '+text+'  \r\n'};
    reply = catalog => rows(catalog!, [text, input.answer]).map(row => ({...row, quote_location: {line_start: -900, line_end: 9999}}));
    const result = await assess(input);
    expect(result.verdict).toBe('ALLOW');
    expect(result.step_evaluations[0].quote).toBe(text);
    expect(result.step_evaluations[0].quote_location!.line_start).toBe(2);
    const cite = result.output_contract!.source_references!.citations[0];
    expect(input.trace_steps.slice(cite.start!, cite.end!)).toBe(text);
    expect(result.provenance_violations.some(v => v.includes('PROV_FAIL_03'))).toBe(false);
  });

  it('retains the short-quote floor for valid references', async () => {
    const input = {...mixed(), trace_steps: 'Yes'};
    reply = catalog => rows(catalog!, [input.trace_steps, input.answer]);
    const result = await assess(input);
    expect(result.verdict).not.toBe('ALLOW');
    expect(result.step_evaluations[0].score).toBeLessThanOrEqual(0.4);
  });

  it('bounds the catalog without deleting source evidence or forcing an unavailable address', async () => {
    const input = {...mixed(), trace_steps: 'x'.repeat(2049)+'\n'+Array.from({length: 300}, (_, i) => `Observation ${i} remains in the source evidence.`).join('\n')};
    reply = (catalog, body) => {
      expect(catalog!.passages).toHaveLength(256);
      expect(catalog!.truncated).toBe(true);
      expect(body.messages[1].content).toContain(input.trace_steps);
      // The answer has no catalog slot left, but the existing direct-quote path remains available.
      return [0, 1].map(i => ({step_id: `step_${i}`, score: 0, reasoning: 'The synthetic criterion is not established.', quote: null, quote_ref: null}));
    };
    const result = await assess(input);
    expect(result.verdict).toBe('HOLD');
    expect(result.step_evaluations.every(step => step.score === 0)).toBe(true);
    expect(result.output_contract!.status).toBe('valid');
    expect(result.output_contract!.source_references!.catalog_truncated).toBe(true);
  });

  it.each([[false, true], [true, false]])('keeps callers unchanged with references=%s and strict=%s', async (references, strict) => {
    const input = mixed();
    reply = catalog => {
      expect(catalog).toBeNull();
      return [input.trace_steps, input.answer].map((quote, i) => ({step_id: `step_${i}`, score: 1, reasoning: 'The quote supports the bounded criterion.', quote}));
    };
    const result = await assess(input, references, strict);
    expect(result.verdict).toBe('ALLOW');
    expect(result.output_contract?.source_references).toBeUndefined();
  });

  it('does not enable references for other native Sentinel modes', async () => {
    const request = {...positive, mode: 'plan_revision' as const};
    const shaped = getModeHandler(request.mode)({...request, id: 'non-trade'});
    reply = catalog => {
      expect(catalog).toBeNull();
      return shaped.evalInput.gold_plan_steps.map(s => ({step_id: `step_${s.index}`, score: 0, reasoning: 'Synthetic lack of support.', quote: null}));
    };
    await verify(request);
    expect(calls).toHaveLength(1);
  });
});
