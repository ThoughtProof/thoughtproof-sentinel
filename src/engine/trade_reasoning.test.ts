/**
 * trade_reasoning mode — engine integration tests (ADR-0018)
 *
 * Mirrors engine.test.ts mocking style. Verifies:
 *   - trade_reasoning has 3 gold steps with the NEW inferential-integrity step_2
 *   - CONDITIONAL_ALLOW still maps to UNCERTAIN by default (conservative)
 *   - step_2-only promotion lifts UNCERTAIN → ALLOW when facts (0,1) pass
 *   - promotion does NOT fire when a factual step is weak
 *   - promotion does NOT touch trade_execution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pot-cli/plv', () => ({ evaluateItem: vi.fn() }));
vi.mock('pot-cli/cascade', () => ({ runCascade: vi.fn() }));
vi.mock('pot-cli/verdict', () => ({
  toPublicVerdict: vi.fn((internal: string) => {
    const map: Record<string, string> = {
      ALLOW: 'ALLOW', CONDITIONAL_ALLOW: 'ALLOW', HOLD: 'UNCERTAIN', BLOCK: 'BLOCK', DISSENT: 'UNCERTAIN',
    };
    return { verdict: map[internal] ?? 'UNCERTAIN', metadata: { schema_version: 'v2', confidence: 'high' } };
  }),
}));

import { verify } from './index.js';
import { evaluateItem } from 'pot-cli/plv';
import { runCascade } from 'pot-cli/cascade';
import type { SentinelVerifyRequest } from '../types.js';

const mockEvaluateItem = vi.mocked(evaluateItem);
const mockRunCascade = vi.mocked(runCascade);

/** Build a cascade item result with explicit per-step evaluations. */
function makeResultWithSteps(
  verdict: string,
  steps: Array<{ step_id: string; predicate: string; score: number }>,
) {
  return {
    id: 'tr-test',
    verdict,
    verdict_reasoning: `reasoning for ${verdict}`,
    step_evaluations: steps.map((s) => ({ ...s, quote: 'q', reasoning: 'r' })),
    provenance_violations: [],
    overall_score: steps.reduce((a, s) => a + s.score, 0) / (steps.length || 1),
    tier1_stats: undefined,
  };
}

const req = (overrides: Partial<SentinelVerifyRequest> = {}): SentinelVerifyRequest => ({
  claim: 'BUY market order: 100 USDC of XLM-USDC on Coinbase',
  evidence: 'Thesis: XLM momentum continuation. Reasoning: trend up, volume confirms.',
  mode: 'trade_reasoning',
  tier: 'standard',
  ...overrides,
});

describe('trade_reasoning mode (ADR-0018)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has 3 gold steps with the inferential-integrity step_2', async () => {
    mockRunCascade.mockResolvedValueOnce({
      verdict: 'ALLOW', reason: 'agreement_allow',
      primary: makeResultWithSteps('ALLOW', [{ step_id: 'step_0', predicate: 'faithful', score: 0.9 }]),
      secondary: makeResultWithSteps('ALLOW', [{ step_id: 'step_0', predicate: 'faithful', score: 0.9 }]),
      primaryModel: 'nano', secondaryModel: 'pro', secondaryInvoked: true, degradedMode: false, errors: [], totalLatencyMs: 100,
    } as any);

    await verify(req());

    // runSentinelCascade calls pot-cli runCascade(evalInput, evaluate, config)
    // → mock.calls[0][0] IS the evalInput.
    const evalInput = mockRunCascade.mock.calls[0][0] as any;
    expect(evalInput.gold_plan_steps).toHaveLength(3);
    const step2 = evalInput.gold_plan_steps[2];
    expect(step2.acceptance_criterion.toLowerCase()).toContain('inferential');
    // It must NOT use the old evidence-grounding "fabricated" phrasing as the gate.
    expect(step2.acceptance_criterion.toLowerCase()).toContain('contradicts the reasoning');
  });

  it('maps CONDITIONAL_ALLOW → UNCERTAIN when a factual step is weak (no promotion)', async () => {
    mockRunCascade.mockResolvedValueOnce({
      verdict: 'CONDITIONAL_ALLOW', reason: 'agreement_conditional_allow',
      primary: makeResultWithSteps('CONDITIONAL_ALLOW', [
        { step_id: 'step_0', predicate: 'weakly_faithful', score: 0.5 }, // factual weak
        { step_id: 'step_1', predicate: 'faithful', score: 0.9 },
        { step_id: 'step_2', predicate: 'weakly_faithful', score: 0.5 },
      ]),
      secondary: makeResultWithSteps('CONDITIONAL_ALLOW', [{ step_id: 'step_0', predicate: 'faithful', score: 0.9 }]),
      primaryModel: 'nano', secondaryModel: 'pro', secondaryInvoked: true, degradedMode: false, errors: [], totalLatencyMs: 100,
    } as any);

    const res = await verify(req());
    expect(res.verdict).toBe('UNCERTAIN'); // factual step weak → stays gated
  });

  it('promotes UNCERTAIN → ALLOW when only step_2 is weak (facts pass)', async () => {
    // NOTE: runSentinelCascade uses (cr.secondary ?? cr.primary) for the final
    // step_evaluations, so the decisive per-step data must live in `secondary`.
    const steps = [
      { step_id: 'step_0', predicate: 'faithful', score: 0.9 },   // factual pass
      { step_id: 'step_1', predicate: 'faithful', score: 0.88 },  // factual pass
      { step_id: 'step_2', predicate: 'weakly_faithful', score: 0.5 }, // only inferential weak
    ];
    mockRunCascade.mockResolvedValueOnce({
      verdict: 'CONDITIONAL_ALLOW', reason: 'agreement_conditional_allow',
      primary: makeResultWithSteps('CONDITIONAL_ALLOW', steps),
      secondary: makeResultWithSteps('CONDITIONAL_ALLOW', steps),
      primaryModel: 'nano', secondaryModel: 'pro', secondaryInvoked: true, degradedMode: false, errors: [], totalLatencyMs: 100,
    } as any);

    const res = await verify(req());
    expect(res.verdict).toBe('ALLOW'); // step_2-only → promoted
  });

  it('does NOT promote in trade_execution mode (same weak-step_2 shape)', async () => {
    const steps = [
      { step_id: 'step_0', predicate: 'faithful', score: 0.9 },
      { step_id: 'step_1', predicate: 'faithful', score: 0.88 },
      { step_id: 'step_2', predicate: 'weakly_faithful', score: 0.5 },
    ];
    mockRunCascade.mockResolvedValueOnce({
      verdict: 'CONDITIONAL_ALLOW', reason: 'agreement_conditional_allow',
      primary: makeResultWithSteps('CONDITIONAL_ALLOW', steps),
      secondary: makeResultWithSteps('CONDITIONAL_ALLOW', steps),
      primaryModel: 'nano', secondaryModel: 'pro', secondaryInvoked: true, degradedMode: false, errors: [], totalLatencyMs: 100,
    } as any);

    const res = await verify(req({ mode: 'trade_execution' }));
    expect(res.verdict).toBe('UNCERTAIN'); // trade_execution never promotes
  });

  it('never promotes a BLOCK', async () => {
    mockRunCascade.mockResolvedValueOnce({
      verdict: 'BLOCK', reason: 'primary_block',
      primary: makeResultWithSteps('BLOCK', [
        { step_id: 'step_0', predicate: 'faithful', score: 0.9 },
        { step_id: 'step_1', predicate: 'faithful', score: 0.9 },
        { step_id: 'step_2', predicate: 'unfaithful', score: 0.1 },
      ]),
      primaryModel: 'nano', secondaryModel: 'pro', secondaryInvoked: false, degradedMode: false, errors: [], totalLatencyMs: 100,
    } as any);

    const res = await verify(req());
    expect(res.verdict).toBe('BLOCK');
  });
});
