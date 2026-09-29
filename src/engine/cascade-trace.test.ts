import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Only provider inference is mocked. The vendored cascade policy is exercised.
vi.mock('pot-cli/plv', () => ({evaluateItem: vi.fn()}));
import {evaluateItem, type ItemResult} from 'pot-cli/plv';
import {verify} from './index.js';
import {buildVerifierTrace} from './verifier-trace.js';
import {buildCanonicalSentinelVerdict} from '../canonical-verdict.js';
import {processSignedEvidence, applyEvidenceEffects} from '../evidence-processing.js';
import type {SentinelVerifyRequest, SentinelVerifyResponse} from '../types.js';
import openapi from '../../api/openapi.js';
import q03Request from './fixtures/sentinel-modes-01/q-03-request.json';
import q03Response from './fixtures/sentinel-modes-01/q-03-response.json';
import q04Request from './fixtures/sentinel-modes-01/q-04-request.json';
import q04Response from './fixtures/sentinel-modes-01/q-04-response.json';

const evaluate = vi.mocked(evaluateItem);
const syntheticPrimaryReason = 'Synthetic primary objection: the follow-up measurement is missing.';
function item(verdict: string, score: number, reason: string | undefined): ItemResult {
  return {
    id: 'synthetic-internal-evaluation', verdict,
    verdict_reasoning: reason ?? '', overall_score: score,
    step_evaluations: [{step_id: 'step_0', predicate: score === 1 ? 'faithful' : 'partially_faithful', score,
      quote: null, reasoning: reason}], provenance_violations: [],
  } as unknown as ItemResult;
}
const secondary = () => ({...item('ALLOW', 1, 'All critical steps adequately supported.'),
  step_evaluations: q03Response.objections.map(o => ({...o}))} as unknown as ItemResult);

describe('cascade evaluator provenance', () => {
  beforeEach(() => {vi.clearAllMocks();vi.stubEnv('CONFIRM_BLOCKS', '0');});
  afterEach(() => vi.unstubAllEnvs());

  it('retains a primary HOLD objection while the legacy surface uses the positive secondary', async () => {
    // The primary fixture is synthetic, NOT a reconstruction of the hidden Q-03 rationale.
    const first = item('HOLD', .5, syntheticPrimaryReason), second = secondary();
    const unchanged = JSON.stringify([first, second]);
    evaluate.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const response = await verify(q03Request as SentinelVerifyRequest);
    expect(response.verdict).toBe('UNCERTAIN');
    expect(response.objections).toEqual(q03Response.objections);
    expect(JSON.stringify([first, second])).toBe(unchanged);
    const trace = (response.meta as any).verifier_trace;
    expect(trace).toBeDefined();
    expect(trace.legacy_surface_stage).toBe('secondary');
    expect(trace.cascade_reason).toBe('primary_hold');
    expect(trace.retained_primary_restriction).toBe(true);
    expect(trace.stages[0].verdict).toBe('HOLD');
    expect(trace.stages[0].objections[0].reasoning).toBe(syntheticPrimaryReason);
    expect(trace.stages[1].verdict).toBe('ALLOW');
    expect(trace.stages[1].objections.every((o: any) => o.score === 1)).toBe(true);
    expect(trace.signature_scope).toBe('unsigned_diagnostics');
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('reproduces Q-04 criterion-only fallback and exposes the absence of evaluator explanations', async () => {
    const primary = {...item('BLOCK', 0, undefined), verdict_reasoning: 'Two failed criteria.',
      step_evaluations: q04Response.objections.map(o => ({step_id: o.step_id, predicate: o.predicate, score: o.score, quote: null}))} as unknown as ItemResult;
    evaluate.mockResolvedValueOnce(primary);
    const response = await verify(q04Request as SentinelVerifyRequest), trace = response.meta.verifier_trace!;
    expect(response.verdict).toBe('BLOCK');
    expect(response.objections).toEqual(q04Response.objections);
    expect(trace.missing_reason_steps).toEqual([{stage: 'primary', step_id: 'step_0'}, {stage: 'primary', step_id: 'step_1'}]);
    expect(trace.stages[0].objections.every(o => o.reasoning_source === 'criterion_fallback' && !o.evaluator_reasoning_present)).toBe(true);
    expect(trace.stages[1]).toMatchObject({status: 'not_invoked', verdict: null, reasoning: null, objections: []});
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('retains a real source-linked objection without inventing a repair guarantee', async () => {
    const reason = 'The proposal claims no errors; Q1 reports two errors.';
    const first = item('HOLD', 0, reason);
    first.step_evaluations[0].quote = 'Bei 18 Texten war das Feld korrekt, bei 2 Texten falsch.';
    evaluate.mockResolvedValueOnce(first).mockResolvedValueOnce(secondary());
    const response = await verify(q03Request as SentinelVerifyRequest), step = response.meta.verifier_trace!.stages[0].objections[0];
    expect(step).toMatchObject({reasoning: reason, reasoning_source: 'evaluator', evaluator_reasoning_present: true,
      quote: first.step_evaluations[0].quote, quote_source: 'cascade', quote_match_mode: 'exact'});
    expect(step).not.toHaveProperty('repair_sufficient');
    expect(response.verdict).toBe('UNCERTAIN');
  });

  it('applies quote validation to the primary trace, not only the selected secondary', async () => {
    const first = item('HOLD', 0, 'A supplied source contradicts the proposal.');
    first.step_evaluations[0].quote = 'This quote is not in the actual evidence.';
    evaluate.mockResolvedValueOnce(first).mockResolvedValueOnce(secondary());
    const trace = (await verify(q03Request as SentinelVerifyRequest)).meta.verifier_trace!;
    expect(trace.stages[0].objections[0].quote).toBeNull();
    expect(trace.stages[0].objections[0].quote_source).toBeNull();
  });

  it('does not reintroduce a false numeric objection through either the primary step or summary', async () => {
    evaluate.mockResolvedValueOnce(item('HOLD', 0, 'Total exceeds budget ceiling.')).mockResolvedValueOnce(item('ALLOW', 1, 'All conditions supported.'));
    const response = await verify({claim: 'Prepare an internal note.', evidence: 'The internal note can be prepared.', mode: 'plan_revision',
      mandate: {granted: {maxAmount: 600}, action: {amount: 583}}});
    const first = response.meta.verifier_trace!.stages[0];
    expect(first.reasoning_source).toBe('evidence_bind');
    expect(first.reasoning).toContain('objection_evidence_fail');
    expect(first.objections[0].reasoning_source).toBe('evidence_bind');
    expect(first.objections[0].reasoning).toContain('objection_evidence_fail');
    expect(response.verdict).toBe('UNCERTAIN');
  });

  it('distinguishes a failed secondary after primary HOLD from a secondary that was never invoked', async () => {
    evaluate.mockResolvedValueOnce(item('HOLD', .5, syntheticPrimaryReason)).mockRejectedValueOnce(new Error('synthetic secondary unavailable'));
    const trace = (await verify(q03Request as SentinelVerifyRequest)).meta.verifier_trace!;
    expect(trace.stages[0].status).toBe('completed');
    expect(trace.stages[1]).toMatchObject({status: 'unavailable', verdict: null, reasoning: null, objections: []});
    expect(trace.legacy_surface_stage).toBe('primary');
    expect(JSON.stringify(trace)).not.toContain('synthetic secondary unavailable');
  });

  it('distinguishes a failed primary from the successful fallback', async () => {
    evaluate.mockRejectedValueOnce(new Error('synthetic primary unavailable')).mockResolvedValueOnce(secondary());
    const trace = (await verify(q03Request as SentinelVerifyRequest)).meta.verifier_trace!;
    expect(trace.cascade_reason).toBe('primary_error_fallback');
    expect(trace.stages[0]).toMatchObject({status: 'unavailable', verdict: null, objections: []});
    expect(trace.stages[1]).toMatchObject({status: 'completed', verdict: 'ALLOW'});
  });

  it('does not override primary-BLOCK rejection or reinterpret it as an execution permission', async () => {
    vi.stubEnv('CONFIRM_BLOCKS', '1');
    evaluate.mockResolvedValueOnce(item('BLOCK', 0, syntheticPrimaryReason)).mockResolvedValueOnce(secondary());
    const response = await verify(q03Request as SentinelVerifyRequest);
    expect(response.verdict).toBe('UNCERTAIN');
    expect(response.meta.verifier_trace).toMatchObject({cascade_reason: 'primary_block_rejected', retained_primary_restriction: true});
  });

  it('identifies solo evaluation without inventing a second reviewer', async () => {
    evaluate.mockResolvedValueOnce(secondary());
    const response = await verify({...q03Request, tier: 'checkpoint'} as SentinelVerifyRequest);
    expect(response.verdict).toBe('ALLOW');
    expect(response.meta.verifier_trace!.stages).toHaveLength(1);
    expect(response.meta.verifier_trace).toMatchObject({legacy_surface_stage: 'solo', retained_primary_restriction: false});
  });

  it('cannot reconstruct historic Q-03 primary detail from its reasoning marker', () => {
    const legacy = {result: {...secondary(), verdict: 'HOLD', verdict_reasoning: q03Response.reasoning} as ItemResult,
      modelsUsed: ['serv-nano', 'serv-swift'], cascadeReason: 'primary_hold'};
    expect(buildVerifierTrace(legacy, new Map(), q03Request.evidence, q03Request as SentinelVerifyRequest, 'UNCERTAIN')).toBeUndefined();
    expect(q03Response).not.toHaveProperty('meta.verifier_trace');
  });

  it('keeps the historical canonical verdict identical and makes unsigned trace tampering irrelevant to its digest', async () => {
    evaluate.mockResolvedValueOnce(item('HOLD', .5, syntheticPrimaryReason)).mockResolvedValueOnce(secondary());
    const response = await verify(q03Request as SentinelVerifyRequest);
    response.meta.verified_at = q03Response.meta.verified_at;
    const before = buildCanonicalSentinelVerdict(response);
    expect(before).toEqual(buildCanonicalSentinelVerdict(q03Response as SentinelVerifyResponse));
    response.meta.verifier_trace!.stages[0].reasoning = 'tampered unsigned diagnostic';
    expect(buildCanonicalSentinelVerdict(response)).toEqual(before);
    expect(response.verdict).toBe('UNCERTAIN');
  });

  it('leaves response.verdict authoritative when later evidence middleware downgrades the engine result', async () => {
    evaluate.mockResolvedValueOnce(secondary()).mockResolvedValueOnce(secondary());
    const req = {...q03Request, signed_evidence: [{type: 'signed_event', raw_event: 'invalid', signature_scheme: 'ed25519',
      signer_pubkey: 'invalid', claims: ['test'], verification: 'required'}]} as SentinelVerifyRequest;
    const response = await verify(req), processed = applyEvidenceEffects(response, processSignedEvidence(req), req);
    expect(processed.verdict).toBe('BLOCK');
    expect(processed.meta.verifier_trace!.engine_verdict).toBe('ALLOW');
    expect(processed.meta.verifier_trace).not.toHaveProperty('authorizes_execution');
  });

  it('documents the optional unsigned trace in the public schema', () => {
    let doc: any;
    const res = {setHeader() {}, status() {return res;}, json(value: unknown) {doc = value;}};
    openapi({} as never, res as never);
    const schema = doc.paths['/sentinel/verify'].post.responses['200'].content['application/json'].schema;
    expect(schema.properties.meta.properties.verifier_trace.description).toContain('unsigned');
    expect(schema.properties.meta.properties.verifier_trace.properties.signature_scope.enum).toEqual(['unsigned_diagnostics']);
    expect(schema.properties.meta.required ?? []).not.toContain('verifier_trace');
  });

  it.each([
    ['ALLOW', 'ALLOW', 'ALLOW'], ['ALLOW', 'CONDITIONAL_ALLOW', 'ALLOW'],
    ['ALLOW', 'HOLD', 'UNCERTAIN'], ['ALLOW', 'BLOCK', 'UNCERTAIN'],
    ['CONDITIONAL_ALLOW', 'ALLOW', 'ALLOW'], ['CONDITIONAL_ALLOW', 'CONDITIONAL_ALLOW', 'ALLOW'],
    ['CONDITIONAL_ALLOW', 'HOLD', 'UNCERTAIN'], ['CONDITIONAL_ALLOW', 'BLOCK', 'UNCERTAIN'],
    ['HOLD', 'ALLOW', 'UNCERTAIN'], ['HOLD', 'CONDITIONAL_ALLOW', 'UNCERTAIN'],
    ['HOLD', 'HOLD', 'UNCERTAIN'], ['HOLD', 'BLOCK', 'BLOCK'],
  ])('keeps the existing nonfinancial cascade rule: %s + %s => %s', async (primary, next, expected) => {
    evaluate.mockResolvedValueOnce(item(primary, .5, 'Synthetic primary result.'))
      .mockResolvedValueOnce(item(next, .5, 'Synthetic secondary result.'));
    const response = await verify(q03Request as SentinelVerifyRequest);
    expect(response.verdict).toBe(expected);
    expect(response.meta.verifier_trace!.stages.map(s => s.verdict)).toEqual([primary, next]);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});
