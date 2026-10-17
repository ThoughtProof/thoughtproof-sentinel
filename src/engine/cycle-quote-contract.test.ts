import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The real router, evaluator and Sentinel run; the only replacement is HTTP.
vi.hoisted(() => {
  process.env.SERV_API_KEY = 'offline-fixture-only';
  process.env.SERV_BASE_URL = 'https://offline.invalid/v1';
});
import {verify} from './index.js';
import type {SentinelVerifyRequest} from '../types.js';

function fixture(name: string): SentinelVerifyRequest {
  return JSON.parse(readFileSync(new URL(`./fixtures/cycle-quotes-20261017/${name}_request.json`, import.meta.url), 'utf8'));
}
const positive = fixture('supported_control');
const risk = fixture('risk_contradiction');
const missing = fixture('missing_evidence');
const quotes = positive.evidence.split('\n').filter(line => /^Pre-decision reasoning [123]:/.test(line));
const complete = () => quotes.map((quote, i) => ({
  step_id: `step_${i}`, score: 1, quote,
  reasoning: 'Synthetic reviewer: this supplied pre-decision statement supports the criterion.',
}));
let bodies: string[], calls: number;
beforeEach(() => {
  bodies = []; calls = 0;
  vi.stubEnv('CONFIRM_BLOCKS', '0');
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    expect(String(url)).toBe('https://offline.invalid/v1/chat/completions');
    expect(JSON.parse(String(options?.body)).model).toMatch(/^serv-(nano|swift)$/);
    if (!bodies.length) throw Error('UNPLANNED_OFFLINE_COMPLETION');
    calls++;
    return new Response(JSON.stringify({choices: [{message: {content: bodies.shift()}}], model: 'synthetic-only'}));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Cycle Engine trade-execution quote regression', () => {
  it('identifies omitted fields as a technical failure, with no invented market objections or retry', async () => {
    const raw = JSON.stringify(complete().map(({step_id, score}) => ({step_id, score})));
    bodies.push(raw);
    const result = await verify(positive);
    expect(result.verdict).toBe('UNCERTAIN');
    expect(result.confidence).toBe(0);
    expect(result.objections).toEqual([]);
    const contract = result.meta.verifier_trace!.stages[0].output_contract!;
    expect(contract.status).toBe('invalid');
    expect(contract.response_sha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(contract.issues).toHaveLength(6);
    expect(contract.shape!.rows).toHaveLength(3);
    for (const row of contract.shape!.rows) {
      expect(row.fields).toMatchObject({score: {state: 'valid'}, reasoning: {state: 'missing'}, quote: {state: 'missing'}});
    }
    expect(result.reasoning).toContain('missing assessment fields are not missing task evidence');
    expect(calls).toBe(1);
  });

  it('preserves a complete cited positive assessment through the real router', async () => {
    const rows = complete(), raw = JSON.stringify(rows);
    bodies.push(raw);
    const result = await verify(positive);
    expect(result.verdict).toBe('ALLOW');
    expect(result.meta.verifier_trace!.stages[0].output_contract).toMatchObject({
      status: 'valid', response_sha256: createHash('sha256').update(raw).digest('hex'),
    });
    expect(result.objections.map(row => row.quote)).toEqual(quotes);
    expect(result.objections.map(row => row.reasoning)).toEqual(rows.map(row => row.reasoning));
    expect(result.meta.verifier_trace!.stages[0].objections.every(row =>
      row.quote_diagnostics?.candidate_present && row.quote_diagnostics.evaluator_match_path === 'exact'
      && row.quote_diagnostics.evaluator_failure_codes.length === 0)).toBe(true);
    expect(calls).toBe(1);
  });

  it('distinguishes an explicit null quote from an omitted response field and keeps the provenance floor', async () => {
    bodies.push(JSON.stringify(complete().map(row => ({...row, quote: null}))));
    const result = await verify(positive);
    expect(result.verdict).toBe('UNCERTAIN');
    expect(result.meta.verifier_trace!.stages[0].output_contract?.status).toBe('valid');
    expect(result.objections).toHaveLength(3);
    expect(result.objections.every(row => row.score <= 0.25 && row.quote === null)).toBe(true);
    expect(result.meta.verifier_trace!.stages[0].objections.every(row =>
      row.quote_diagnostics?.candidate_present === false && row.quote_diagnostics.candidate_sha256 === null
      && row.quote_diagnostics.evaluator_failure_codes.includes('PROV_FAIL_01'))).toBe(true);
    expect(calls).toBe(1);
  });

  it('distinguishes a rejected quote from a missing one without exposing the rejected text or lifting the restriction', async () => {
    const candidate = 'PRIVATE_UNMATCHED_CANDIDATE: these words are not a source citation.';
    bodies.push(JSON.stringify(complete().map((row,i) => i === 0 ? {...row,quote:candidate} : row)));
    const result = await verify(positive);
    expect(result.verdict).toBe('UNCERTAIN');
    expect(result.objections[0].quote).toBeNull();
    expect(result.objections[0].score).toBe(0.25);
    expect(result.meta.verifier_trace!.stages[0].objections[0].quote_diagnostics).toEqual({
      candidate_present:true,candidate_length:candidate.length,
      candidate_sha256:createHash('sha256').update(candidate).digest('hex'),
      evaluator_match_path:'no-match',evaluator_failure_codes:['PROV_FAIL_02'],
    });
    expect(JSON.stringify(result)).not.toContain(candidate);
    expect(calls).toBe(1);
  });

  it('identifies missing numeric bounds while preserving valid quotes, scores and the existing verdict', async () => {
    bodies.push(JSON.stringify(complete().map((row,i) => i === 0
      ? {...row,reasoning:'The initial stop loss is within budget.'} : row)));
    const result = await verify(positive);
    const step = result.meta.verifier_trace!.stages[0].objections[0];
    expect(result.verdict).toBe('ALLOW');
    expect(step.score).toBe(1);
    expect(step.quote).toBe(quotes[0]);
    expect(step.reasoning).toContain('objection_unverified');
    expect(step.numeric_binding).toEqual({status:'unverified_insufficient_bounds',has_amount:false,
      has_ceiling:true,relation:'within',verdict_unchanged:true});
    expect(calls).toBe(1);
  });

  it('keeps a source-linked risk contradiction blocked', async () => {
    const quote = 'The proposal claim incorrectly says stop 1900 and loss 50.';
    expect(risk.evidence).toContain(quote);
    bodies.push(JSON.stringify(complete().map((row, i) => ({
      ...row, score: i === 1 ? 1 : 0,
      quote: i === 1 ? 'Closed prices rise from 1980 to 1990 to 2000.' : quote,
      reasoning: i === 1 ? 'The closed prices rise.' : 'The proposed stop and loss contradict the supplied order facts.',
    }))));
    const result = await verify(risk);
    expect(result.verdict).toBe('BLOCK');
    expect(result.meta.verifier_trace!.stages[0].output_contract?.status).toBe('valid');
    expect(result.objections[2].quote).toBe(quote);
    expect(calls).toBe(1);
  });

  it('keeps explicitly absent evidence blocked without inventing citations', async () => {
    const quote = 'The proposed amount, entry, stop, leverage, price history, kernel history and cycle observations are not supplied or verified.';
    expect(missing.evidence).toContain(quote);
    bodies.push(JSON.stringify(complete().map(row => ({...row, score: 0, quote, reasoning: 'The required observations are explicitly unavailable.'}))));
    const result = await verify(missing);
    expect(result.verdict).toBe('BLOCK');
    expect(result.meta.verifier_trace!.stages[0].output_contract?.status).toBe('valid');
    expect(result.objections.every(row => row.quote === quote)).toBe(true);
    expect(calls).toBe(1);
  });

  it('never promotes malformed primary output after a complete secondary ALLOW', async () => {
    bodies.push(JSON.stringify(complete().map(({step_id, score}) => ({step_id, score}))), JSON.stringify(complete()));
    const result = await verify({...positive, tier: 'standard'});
    expect(result.verdict).toBe('UNCERTAIN');
    const stages = result.meta.verifier_trace!.stages;
    expect(stages[0].output_contract?.status).toBe('invalid');
    expect(stages[1].output_contract?.status).toBe('valid');
    expect(stages[1].verdict).toBe('ALLOW');
    expect(calls).toBe(2);
  });
});
