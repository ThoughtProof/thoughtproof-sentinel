/**
 * Sentinel Engine Tests
 *
 * Tests the engine as a pure function: SentinelVerifyRequest → SentinelVerifyResponse
 * No HTTP server, no auth mocks, no payment mocks.
 *
 * These tests mock pot-cli's evaluateItem and runCascade to test
 * the engine's orchestration logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pot-cli modules before imports
vi.mock('pot-cli/plv', () => ({
  evaluateItem: vi.fn(),
}));

vi.mock('pot-cli/cascade', () => ({
  runCascade: vi.fn(),
}));

vi.mock('pot-cli/verdict', () => ({
  toPublicVerdict: vi.fn((internal: string) => {
    const map: Record<string, string> = {
      ALLOW: 'ALLOW',
      CONDITIONAL_ALLOW: 'ALLOW',
      HOLD: 'UNCERTAIN',
      BLOCK: 'BLOCK',
      DISSENT: 'UNCERTAIN',
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

function makeItemResult(verdict: string, score: number = 0.85) {
  return {
    id: 'test-1',
    verdict,
    verdict_reasoning: `Test reasoning for ${verdict}`,
    step_evaluations: [
      {
        step_id: 'step-0',
        predicate: 'supported',
        score,
        quote: 'test quote',
        reasoning: 'step reasoning',
      },
    ],
    provenance_violations: [],
    overall_score: score,
    tier1_stats: undefined,
  };
}

describe('Sentinel Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('verify()', () => {
    it('should return ALLOW for checkpoint tier (Nano solo)', async () => {
      const itemResult = makeItemResult('ALLOW', 0.9);
      mockEvaluateItem.mockResolvedValueOnce(itemResult as any);

      const req: SentinelVerifyRequest = {
        claim: 'The agent correctly summarized the data',
        evidence: 'Source data shows X, Y, Z. Agent reported X, Y, Z.',
        mode: 'handoff',
        tier: 'checkpoint',
      };

      const res = await verify(req);

      expect(res.verdict).toBe('ALLOW');
      expect(res.confidence).toBeGreaterThan(0);
      expect(res.mode).toBe('handoff');
     expect(res.tier).toBe('checkpoint');
      expect(res.meta.models_used).toEqual(['serv-nano']);
     expect(res.id).toMatch(/^sent_/);
      expect(res.meta.duration_ms).toBeGreaterThanOrEqual(0);
      expect(res.meta.verified_at).toBeTruthy();

      // Should NOT call runCascade for checkpoint
      expect(mockRunCascade).not.toHaveBeenCalled();
      // Should call evaluateItem directly
      expect(mockEvaluateItem).toHaveBeenCalledOnce();
    });

    it('should return ALLOW for standard tier (Nano→Pro cascade)', async () => {
      const primaryResult = makeItemResult('ALLOW', 0.88);
      const secondaryResult = makeItemResult('ALLOW', 0.92);

      mockRunCascade.mockResolvedValueOnce({
        verdict: 'ALLOW',
        reason: 'agreement_allow',
        primary: primaryResult,
        secondary: secondaryResult,
        primaryModel: 'nano',
        secondaryModel: 'pro',
        secondaryInvoked: true,
        degradedMode: false,
        errors: [],
        totalLatencyMs: 1200,
      } as any);

      const req: SentinelVerifyRequest = {
        claim: 'Market conditions justify switching from perps to memecoins',
        evidence: 'ETH volatility dropped 40%, memecoin volume up 200% in 24h.',
        mode: 'plan_revision',
      };

      const res = await verify(req);

      expect(res.verdict).toBe('ALLOW');
      expect(res.mode).toBe('plan_revision');
     expect(res.tier).toBe('standard'); // default
      expect(res.meta.models_used).toEqual(['serv-nano', 'serv-pro']);
     expect(mockRunCascade).toHaveBeenCalledOnce();
    });

    it('should return BLOCK when cascade blocks', async () => {
      const primaryResult = makeItemResult('BLOCK', 0.2);

      mockRunCascade.mockResolvedValueOnce({
        verdict: 'BLOCK',
        reason: 'primary_block',
        primary: primaryResult,
        secondary: undefined,
        primaryModel: 'nano',
        secondaryModel: 'pro',
        secondaryInvoked: false,
        degradedMode: false,
        errors: [],
        totalLatencyMs: 800,
      } as any);

      const req: SentinelVerifyRequest = {
        claim: 'The summary is accurate',
        evidence: 'Source says A but summary says B',
        mode: 'memory_write',
      };

      const res = await verify(req);

     expect(res.verdict).toBe('BLOCK');
      expect(res.meta.models_used).toEqual(['serv-nano']); // early exit, no pro
   });

    it('should return UNCERTAIN for HOLD verdict', async () => {
      const primaryResult = makeItemResult('HOLD', 0.5);

      mockRunCascade.mockResolvedValueOnce({
        verdict: 'HOLD',
        reason: 'disagreement_hold',
        primary: primaryResult,
        secondary: makeItemResult('BLOCK', 0.3),
        primaryModel: 'nano',
        secondaryModel: 'pro',
        secondaryInvoked: true,
        degradedMode: false,
        errors: [],
        totalLatencyMs: 1100,
      } as any);

      const req: SentinelVerifyRequest = {
        claim: 'Output is fully supported',
        evidence: 'Partial evidence only',
        mode: 'output_synthesis',
      };

      const res = await verify(req);

      expect(res.verdict).toBe('UNCERTAIN');
    });

    it('should use provided id when given', async () => {
      mockEvaluateItem.mockResolvedValueOnce(makeItemResult('ALLOW') as any);

      const req: SentinelVerifyRequest = {
        id: 'custom-id-123',
        claim: 'test claim',
        evidence: 'test evidence',
        mode: 'handoff',
        tier: 'checkpoint',
      };

      const res = await verify(req);
      expect(res.id).toBe('custom-id-123');
    });

    it('should auto-generate id with sent_ prefix', async () => {
      mockEvaluateItem.mockResolvedValueOnce(makeItemResult('ALLOW') as any);

      const req: SentinelVerifyRequest = {
        claim: 'test claim',
        evidence: 'test evidence',
        mode: 'handoff',
        tier: 'checkpoint',
      };

      const res = await verify(req);
      expect(res.id).toMatch(/^sent_[a-f0-9]{16}$/);
    });
  });

  describe('mode handlers', () => {
    it('should use correct eval input for each mode', async () => {
      const modes = ['handoff', 'plan_revision', 'memory_write', 'output_synthesis', 'trade_execution'] as const;

      for (const mode of modes) {
        vi.clearAllMocks();
        mockEvaluateItem.mockResolvedValueOnce(makeItemResult('ALLOW') as any);

        await verify({
          claim: `claim for ${mode}`,
          evidence: `evidence for ${mode}`,
          mode,
          tier: 'checkpoint',
        });

        expect(mockEvaluateItem).toHaveBeenCalledOnce();
        const callArgs = mockEvaluateItem.mock.calls[0];
        const evalInput = callArgs[0];

        // Each mode should pass claim as answer and evidence as trace_steps
        expect(evalInput.answer).toBe(`claim for ${mode}`);
        expect(evalInput.trace_steps).toBe(`evidence for ${mode}`);
        // Each mode should have at least one gold_plan_step with critical criticality
        expect(evalInput.gold_plan_steps.length).toBeGreaterThan(0);
        expect(evalInput.gold_plan_steps[0].criticality).toBe('critical');
      }
    });

    it('plan_revision should have 2 gold steps (revision + drift)', async () => {
      mockEvaluateItem.mockResolvedValueOnce(makeItemResult('ALLOW') as any);

      await verify({
        claim: 'revised plan',
        evidence: 'market conditions',
        mode: 'plan_revision',
        tier: 'checkpoint',
      });

      const evalInput = mockEvaluateItem.mock.calls[0][0];
      expect(evalInput.gold_plan_steps).toHaveLength(2);
    });

    it('output_synthesis should have 2 gold steps (grounding + logic)', async () => {
      mockEvaluateItem.mockResolvedValueOnce(makeItemResult('ALLOW') as any);

      await verify({
        claim: 'final output',
        evidence: 'evidence chain',
        mode: 'output_synthesis',
        tier: 'checkpoint',
      });

      const evalInput = mockEvaluateItem.mock.calls[0][0];
      expect(evalInput.gold_plan_steps).toHaveLength(2);
    });

    it('trade_execution should have 3 gold steps (thresholds + direction + fabrication)', async () => {
      mockEvaluateItem.mockResolvedValueOnce(makeItemResult('ALLOW') as any);

      await verify({
        claim: 'buy BTC',
        evidence: 'price data',
        mode: 'trade_execution',
        tier: 'checkpoint',
      });

      const evalInput = mockEvaluateItem.mock.calls[0][0];
      expect(evalInput.gold_plan_steps).toHaveLength(3);
      expect(evalInput.gold_plan_steps[0].criticality).toBe('critical');
      expect(evalInput.gold_plan_steps[1].criticality).toBe('critical');
      expect(evalInput.gold_plan_steps[2].criticality).toBe('critical');
    });

    it('trade_execution maps CONDITIONAL_ALLOW to UNCERTAIN (conservative)', async () => {
      mockEvaluateItem.mockResolvedValueOnce(makeItemResult('CONDITIONAL_ALLOW') as any);

      const res = await verify({
        claim: 'buy BTC borderline',
        evidence: 'weak data',
        mode: 'trade_execution',
        tier: 'checkpoint',
      });

      expect(res.verdict).toBe('UNCERTAIN');
    });

    it('output_synthesis maps CONDITIONAL_ALLOW to ALLOW (default)', async () => {
      mockEvaluateItem.mockResolvedValueOnce(makeItemResult('CONDITIONAL_ALLOW') as any);

      const res = await verify({
        claim: 'output claim',
        evidence: 'evidence',
        mode: 'output_synthesis',
        tier: 'checkpoint',
      });

      expect(res.verdict).toBe('ALLOW');
    });
  });

  describe('tier routing', () => {
    it('checkpoint uses evaluateItem directly (no cascade)', async () => {
      mockEvaluateItem.mockResolvedValueOnce(makeItemResult('ALLOW') as any);

      await verify({
        claim: 'test', evidence: 'test', mode: 'handoff', tier: 'checkpoint',
      });

      expect(mockEvaluateItem).toHaveBeenCalledOnce();
      expect(mockRunCascade).not.toHaveBeenCalled();
    });

    it('standard uses runCascade (Nano→Pro)', async () => {
      mockRunCascade.mockResolvedValueOnce({
        verdict: 'ALLOW',
        reason: 'agreement_allow',
        primary: makeItemResult('ALLOW'),
        secondary: makeItemResult('ALLOW'),
        primaryModel: 'nano',
        secondaryModel: 'pro',
        secondaryInvoked: true,
        degradedMode: false,
        errors: [],
        totalLatencyMs: 1000,
      } as any);

      await verify({
        claim: 'test', evidence: 'test', mode: 'handoff', tier: 'standard',
      });

      expect(mockRunCascade).toHaveBeenCalledOnce();
      expect(mockEvaluateItem).not.toHaveBeenCalled();
    });

    it('defaults to standard when tier not specified', async () => {
      mockRunCascade.mockResolvedValueOnce({
        verdict: 'ALLOW',
        reason: 'agreement_allow',
        primary: makeItemResult('ALLOW'),
        secondary: makeItemResult('ALLOW'),
        primaryModel: 'nano',
        secondaryModel: 'pro',
        secondaryInvoked: true,
        degradedMode: false,
        errors: [],
        totalLatencyMs: 1000,
      } as any);

      const res = await verify({
        claim: 'test', evidence: 'test', mode: 'handoff',
      });

      expect(res.tier).toBe('standard');
      expect(mockRunCascade).toHaveBeenCalledOnce();
    });
  });

  describe('response shape', () => {
    it('should match SentinelVerifyResponse schema', async () => {
      mockEvaluateItem.mockResolvedValueOnce(makeItemResult('ALLOW', 0.87) as any);

      const res = await verify({
        claim: 'test claim',
        evidence: 'test evidence',
        mode: 'handoff',
        tier: 'checkpoint',
      });

      // Required fields
      expect(res).toHaveProperty('id');
      expect(res).toHaveProperty('verdict');
      expect(res).toHaveProperty('confidence');
      expect(res).toHaveProperty('reasoning');
      expect(res).toHaveProperty('objections');
      expect(res).toHaveProperty('mode');
      expect(res).toHaveProperty('tier');
      expect(res).toHaveProperty('meta');

      // Meta fields
      expect(res.meta).toHaveProperty('duration_ms');
      expect(res.meta).toHaveProperty('models_used');
      expect(res.meta).toHaveProperty('verified_at');

      // Types
      expect(typeof res.id).toBe('string');
      expect(['ALLOW', 'BLOCK', 'UNCERTAIN']).toContain(res.verdict);
      expect(typeof res.confidence).toBe('number');
      expect(typeof res.reasoning).toBe('string');
      expect(typeof res.meta.duration_ms).toBe('number');
      expect(Array.isArray(res.meta.models_used)).toBe(true);
    });

    it('confidence should be rounded to 3 decimal places', async () => {
      const result = makeItemResult('ALLOW', 0.87654321);
      mockEvaluateItem.mockResolvedValueOnce(result as any);

      const res = await verify({
        claim: 'test', evidence: 'test', mode: 'handoff', tier: 'checkpoint',
      });

      // Should be rounded: 0.877
      expect(res.confidence.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3);
    });

    it('surfaces per-step objections mapped from step_evaluations', async () => {
      const result = makeItemResult('BLOCK', 0.2);
      mockEvaluateItem.mockResolvedValueOnce(result as any);

      const res = await verify({
        claim: 'test', evidence: 'test', mode: 'trade_execution', tier: 'checkpoint',
      });

      expect(Array.isArray(res.objections)).toBe(true);
      expect(res.objections).toHaveLength(1);
      const obj = res.objections[0];
      expect(obj.step_id).toBe('step-0');
      expect(obj.predicate).toBe('supported');
      expect(obj.quote).toBe('test quote');
      expect(obj.reasoning).toBe('step reasoning');
      expect(obj.score).toBe(0.2);
    });

    it('returns empty objections array when no step evaluations', async () => {
      const result = { ...makeItemResult('ALLOW'), step_evaluations: [] };
      mockEvaluateItem.mockResolvedValueOnce(result as any);

      const res = await verify({
        claim: 'test', evidence: 'test', mode: 'handoff', tier: 'checkpoint',
      });

      expect(res.objections).toEqual([]);
      expect(res.confidence).toBe(0);
    });
  });
});
