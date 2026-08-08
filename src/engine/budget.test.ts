/**
 * Reliability Option 3 — engine budget mandatory tests.
 *
 * 1. Normal run under budget
 * 2. Primary timeout → REVIEW
 * 3. Secondary timeout → REVIEW
 * 4. Prior BLOCK stays BLOCK
 * 5. Deadline race at 45s
 * 6. Late promise does not overwrite result
 * 7. Release-ID + timeout metadata complete
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    return {
      verdict: map[internal] ?? 'UNCERTAIN',
      metadata: { schema_version: 'v2', confidence: 'high' },
    };
  }),
}));

import { evaluateItem } from 'pot-cli/plv';
import { runCascade } from 'pot-cli/cascade';
import { verify } from './index.js';
import {
  ENGINE_BUDGET_MS,
  ENGINE_BUDGET_REASON,
  ENGINE_RESERVE_MS,
  VERCEL_MAX_DURATION_S,
  EngineBudgetExhaustedError,
  buildBudgetTrace,
  publicVerdictOnBudgetExhaust,
  raceAgainstBudget,
  startEngineBudget,
} from './budget.js';
import type { SentinelVerifyRequest } from '../types.js';

const mockEvaluateItem = vi.mocked(evaluateItem);
const mockRunCascade = vi.mocked(runCascade);

function makeItem(verdict: string, score = 0.9) {
  return {
    id: 't1',
    verdict,
    verdict_reasoning: `reason ${verdict}`,
    step_evaluations: [
      {
        step_id: 'step_0',
        predicate: 'supported',
        score,
        quote: null,
        reasoning: 'ok',
      },
    ],
    provenance_violations: [],
    overall_score: score,
  };
}

const baseReq: SentinelVerifyRequest = {
  claim: 'Proposed action: do X\nAgent reasoning: because Y',
  evidence: 'Mandate: allow X\nContext: test\nEvidence:\n- src: observed',
  mode: 'action_authorization',
  tier: 'standard',
};

describe('budget helpers', () => {
  it('publicVerdictOnBudgetExhaust preserves BLOCK only', () => {
    expect(publicVerdictOnBudgetExhaust('BLOCK')).toBe('BLOCK');
    expect(publicVerdictOnBudgetExhaust('ALLOW')).toBe('UNCERTAIN');
    expect(publicVerdictOnBudgetExhaust('HOLD')).toBe('UNCERTAIN');
    expect(publicVerdictOnBudgetExhaust(null)).toBe('UNCERTAIN');
  });

  it('buildBudgetTrace never marks ALLOW', () => {
    const t = buildBudgetTrace({
      stage: 'primary',
      elapsedMs: 45001,
      knownInternalVerdict: 'ALLOW',
    });
    expect(t.public_verdict).toBe('UNCERTAIN');
    expect(t.reason).toBe(ENGINE_BUDGET_REASON);
    expect(t.degradedMode).toBe(true);
    expect(t.budget_ms).toBe(ENGINE_BUDGET_MS);
    expect(t.reserve_ms).toBe(ENGINE_RESERVE_MS);
    expect(t.vercel_max_duration_s).toBe(VERCEL_MAX_DURATION_S);
  });

  it('raceAgainstBudget ignores late resolve after abort', async () => {
    const ac = new AbortController();
    let resolveLate!: (v: string) => void;
    const late = new Promise<string>((r) => {
      resolveLate = r;
    });
    const raced = raceAgainstBudget(late, {
      signal: ac.signal,
      stage: 'primary',
      startedAt: Date.now() - 1000,
      budgetMs: 50,
    });
    ac.abort();
    await expect(raced).rejects.toBeInstanceOf(EngineBudgetExhaustedError);
    // Late resolve must not become an unhandled rejection / winner
    resolveLate('LATE_ALLOW');
    await new Promise((r) => setTimeout(r, 10));
  });

  it('startEngineBudget aborts after budgetMs', async () => {
    vi.useFakeTimers();
    const b = startEngineBudget({ budgetMs: 45_000, startedAt: Date.now() });
    expect(b.controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(b.controller.signal.aborted).toBe(true);
    b.clear();
    vi.useRealTimers();
  });
});

describe('verify() engine budget — mandatory suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.GIT_COMMIT;
    delete process.env.RELEASE_ID;
    process.env.GIT_COMMIT = 'test-release-budget-45s';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Normaler Lauf unter Budget
  it('1) normal run under budget returns cascade verdict', async () => {
    mockRunCascade.mockImplementationOnce(async (_input, evaluate, cfg) => {
      const primary = await evaluate(cfg.primaryModel, _input as any);
      return {
        verdict: 'ALLOW',
        reason: 'agreement_allow',
        primary,
        secondary: primary,
        primaryModel: cfg.primaryModel,
        secondaryModel: cfg.secondaryModel,
        secondaryInvoked: true,
        degradedMode: false,
        errors: [],
        totalLatencyMs: 100,
      };
    });
    mockEvaluateItem.mockResolvedValue(makeItem('ALLOW') as any);

    const res = await verify(baseReq);
    expect(res.verdict).toBe('ALLOW');
    expect(res.meta.engine_budget).toBeUndefined();
    expect(res.meta.promotion?.release_id).toBe('test-release-budget-45s');
  });

  // 2. Primary-Timeout → REVIEW
  it('2) primary timeout → REVIEW + engine_budget_exhausted', async () => {
    mockRunCascade.mockImplementationOnce(async (_input, evaluate, cfg) => {
      // primary hangs until abort
      await evaluate(cfg.primaryModel, _input as any);
      return {
        verdict: 'ALLOW',
        reason: 'should_not_reach',
        primary: makeItem('ALLOW'),
        primaryModel: cfg.primaryModel,
        secondaryModel: cfg.secondaryModel,
        secondaryInvoked: false,
        degradedMode: false,
        errors: [],
        totalLatencyMs: 99999,
      };
    });
    mockEvaluateItem.mockImplementationOnce(
      () =>
        new Promise(() => {
          /* never resolves */
        }) as any,
    );

    // Force immediate abort via tiny budget by mocking start through cascade signal:
    // We inject abort by making evaluate hang and using real short budget via env is not wired —
    // instead abort by advancing: use startEngineBudget path with real timers short-circuit.
    // Direct approach: abort after microtask by patching Promise race — use fake timers + short budget.
    // verify() uses ENGINE_BUDGET_MS constant 45000. Fake-timer advance 45s.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const p = verify(baseReq);
    await vi.advanceTimersByTimeAsync(45_100);
    const res = await p;
    expect(res.verdict).toBe('UNCERTAIN'); // REVIEW
    expect(res.verdict).not.toBe('ALLOW');
    expect(res.meta.engine_budget?.reason).toBe(ENGINE_BUDGET_REASON);
    expect(res.meta.engine_budget?.degradedMode).toBe(true);
    expect(res.meta.engine_budget?.stage).toBeTruthy();
    expect(res.meta.engine_budget?.budget_ms).toBe(ENGINE_BUDGET_MS);
    expect(res.meta.engine_budget?.public_verdict).toBe('UNCERTAIN');
    expect(res.meta.promotion?.reason).toBe(ENGINE_BUDGET_REASON);
    expect(res.meta.promotion?.release_id).toBe('test-release-budget-45s');
  });

  // 3. Secondary-Timeout → REVIEW
  it('3) secondary timeout → REVIEW', async () => {
    mockRunCascade.mockImplementationOnce(async (_input, evaluate, cfg) => {
      const primary = await evaluate(cfg.primaryModel, _input as any);
      // secondary hangs
      await evaluate(cfg.secondaryModel, _input as any);
      return {
        verdict: 'ALLOW',
        reason: 'agreement_allow',
        primary,
        secondary: primary,
        primaryModel: cfg.primaryModel,
        secondaryModel: cfg.secondaryModel,
        secondaryInvoked: true,
        degradedMode: false,
        errors: [],
        totalLatencyMs: 99999,
      };
    });
    mockEvaluateItem
      .mockResolvedValueOnce(makeItem('ALLOW') as any)
      .mockImplementationOnce(
        () =>
          new Promise(() => {
            /* hang secondary */
          }) as any,
      );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const p = verify(baseReq);
    await vi.advanceTimersByTimeAsync(45_100);
    const res = await p;
    expect(res.verdict).toBe('UNCERTAIN');
    expect(res.meta.engine_budget?.reason).toBe(ENGINE_BUDGET_REASON);
    // primary completed ALLOW — must NOT preserve as public ALLOW
    expect(res.verdict).not.toBe('ALLOW');
    expect(res.meta.engine_budget?.known_internal_verdict).not.toBe('BLOCK');
  });

  // 4. Vorheriges BLOCK bleibt BLOCK
  it('4) prior known BLOCK stays BLOCK on budget exhaust', async () => {
    mockRunCascade.mockImplementationOnce(async (_input, evaluate, cfg) => {
      const primary = await evaluate(cfg.primaryModel, _input as any);
      // After BLOCK primary, hang on a synthetic second call path:
      // With confirmBlocks OFF, cascade would early-exit on BLOCK. Simulate
      // confirmBlocks path that still invokes secondary after BLOCK.
      await evaluate(cfg.secondaryModel, _input as any);
      return {
        verdict: 'BLOCK',
        reason: 'primary_block',
        primary,
        primaryModel: cfg.primaryModel,
        secondaryModel: cfg.secondaryModel,
        secondaryInvoked: true,
        degradedMode: false,
        errors: [],
        totalLatencyMs: 99999,
      };
    });
    mockEvaluateItem
      .mockResolvedValueOnce(makeItem('BLOCK') as any)
      .mockImplementationOnce(
        () =>
          new Promise(() => {
            /* hang after BLOCK known */
          }) as any,
      );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const p = verify(baseReq);
    await vi.advanceTimersByTimeAsync(45_100);
    const res = await p;
    expect(res.verdict).toBe('BLOCK');
    expect(res.meta.engine_budget?.public_verdict).toBe('BLOCK');
    expect(res.meta.engine_budget?.known_internal_verdict).toBe('BLOCK');
    expect(res.meta.engine_budget?.reason).toBe(ENGINE_BUDGET_REASON);
  });

  // 5. Deadline-Race bei 45s
  it('5) deadline race at 45s fires budget path', async () => {
    mockRunCascade.mockImplementationOnce(async (_input, evaluate, cfg) => {
      await evaluate(cfg.primaryModel, _input as any);
      return {
        verdict: 'ALLOW',
        reason: 'too_late',
        primary: makeItem('ALLOW'),
        primaryModel: cfg.primaryModel,
        secondaryModel: cfg.secondaryModel,
        secondaryInvoked: false,
        degradedMode: false,
        errors: [],
        totalLatencyMs: 45000,
      };
    });
    // Resolve primary just after the 45s wall via fake timers
    let resolvePrimary!: (v: unknown) => void;
    mockEvaluateItem.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolvePrimary = r;
        }) as any,
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const p = verify(baseReq);
    await vi.advanceTimersByTimeAsync(45_000);
    // Late primary resolve after abort
    resolvePrimary(makeItem('ALLOW'));
    const res = await p;
    expect(res.meta.engine_budget?.reason).toBe(ENGINE_BUDGET_REASON);
    expect(res.verdict).not.toBe('ALLOW');
    expect(res.meta.engine_budget?.elapsed_ms).toBeGreaterThanOrEqual(45_000 - 50);
  });

  // 6. Keine späte Promise überschreibt das Ergebnis
  it('6) late promise does not overwrite budget REVIEW', async () => {
    let resolveSecondary!: (v: unknown) => void;
    mockRunCascade.mockImplementationOnce(async (_input, evaluate, cfg) => {
      const primary = await evaluate(cfg.primaryModel, _input as any);
      const secondary = await evaluate(cfg.secondaryModel, _input as any);
      return {
        verdict: 'ALLOW',
        reason: 'agreement_allow',
        primary,
        secondary,
        primaryModel: cfg.primaryModel,
        secondaryModel: cfg.secondaryModel,
        secondaryInvoked: true,
        degradedMode: false,
        errors: [],
        totalLatencyMs: 99999,
      };
    });
    mockEvaluateItem
      .mockResolvedValueOnce(makeItem('HOLD') as any)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSecondary = r;
          }) as any,
      );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const p = verify(baseReq);
    await vi.advanceTimersByTimeAsync(45_100);
    const res = await p;
    expect(res.verdict).toBe('UNCERTAIN');
    // Late ALLOW must not flip the settled response object
    resolveSecondary(makeItem('ALLOW'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(res.verdict).toBe('UNCERTAIN');
    expect(res.meta.engine_budget?.late_result_ignored).toBe(true);
  });

  // 7. Release-ID und Timeout-Metadaten vollständig
  it('7) release_id and timeout metadata complete', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'd219dc9deadbeef';
    mockRunCascade.mockImplementationOnce(async (_input, evaluate, cfg) => {
      await evaluate(cfg.primaryModel, _input as any);
      return {
        verdict: 'ALLOW',
        reason: 'x',
        primary: makeItem('ALLOW'),
        primaryModel: cfg.primaryModel,
        secondaryModel: cfg.secondaryModel,
        secondaryInvoked: false,
        degradedMode: false,
        errors: [],
        totalLatencyMs: 1,
      };
    });
    mockEvaluateItem.mockImplementationOnce(
      () =>
        new Promise(() => {
          /* hang */
        }) as any,
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const p = verify(baseReq);
    await vi.advanceTimersByTimeAsync(45_100);
    const res = await p;

    const eb = res.meta.engine_budget;
    expect(eb).toBeTruthy();
    expect(eb!.reason).toBe('engine_budget_exhausted');
    expect(eb!.degradedMode).toBe(true);
    expect(typeof eb!.stage).toBe('string');
    expect(typeof eb!.elapsed_ms).toBe('number');
    expect(eb!.budget_ms).toBe(45_000);
    expect(eb!.reserve_ms).toBe(15_000);
    expect(eb!.vercel_max_duration_s).toBe(60);
    expect(eb!.public_verdict === 'BLOCK' || eb!.public_verdict === 'UNCERTAIN').toBe(true);
    expect(typeof eb!.late_result_ignored).toBe('boolean');
    expect(res.meta.promotion?.release_id).toBe('d219dc9deadbeef');
    expect(res.meta.promotion?.reason).toBe(ENGINE_BUDGET_REASON);
    expect(res.meta.duration_ms).toBeGreaterThanOrEqual(0);
    expect(res.meta.verified_at).toBeTruthy();
  });
});
