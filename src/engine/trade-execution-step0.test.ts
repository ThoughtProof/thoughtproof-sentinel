import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveVerdict, evaluateItem, type GoldStep, type ItemResult, type StepEvaluation } from 'pot-cli/plv';
import { mapVerdict } from './verdict.js';
import {
  STEP0_NOT_APPLICABLE_REASON,
  adjustTradeExecutionSteps,
  applyPlainMarketStep0,
  isPlainMarketOrder,
} from './trade-execution-step0.js';

const GOLD: GoldStep[] = [0, 1, 2].map((index) => ({
  index,
  description: `step ${index}`,
  criticality: 'critical',
}));

const PLAIN = 'BUY market order: 75 USDC of XRP-USDC on Coinbase';

function step(id: string, score: number, predicate: StepEvaluation['predicate'], quote: string | null = null): StepEvaluation {
  return {
    step_id: id,
    score,
    tier: score >= 0.75 ? 'strong' : 'none',
    quote,
    quote_location: { line_start: null, line_end: null, char_offset_start: null, char_offset_end: null, turn: null },
    quote_to_criterion_mapping: null,
    reasoning: 'model prose',
    abstain_if_uncertain: false,
    predicate,
  };
}

const boundaries = JSON.parse(readFileSync(
  join(process.cwd(), 'test/fixtures/cb4a-rescore/step0-boundaries.json'),
  'utf8',
)) as {
  plain: string[];
  upper: string[];
  lower: string[];
  ambiguous: string[];
};

describe('plain market order gate', () => {
  it('recognises the captured order shapes and nothing else in the boundary fixture', () => {
    for (const claim of boundaries.plain) expect(isPlainMarketOrder(claim)).toBe(true);
    for (const claim of [...boundaries.upper, ...boundaries.lower, ...boundaries.ambiguous]) {
      expect(isPlainMarketOrder(claim)).toBe(false);
    }
  });

  it('makes step_0 not applicable only for a plain market order', () => {
    const failing = [
      step('step_0', 0, 'unfaithful'),
      step('step_1', 1, 'faithful', 'alpha'),
      step('step_2', 1, 'faithful', 'alpha'),
    ];
    const adjusted = adjustTradeExecutionSteps(failing, PLAIN);
    expect(adjusted[0]?.predicate).toBe('not_applicable');
    expect(adjusted[0]?.reasoning).toBe(STEP0_NOT_APPLICABLE_REASON);
    expect(deriveVerdict(adjusted, GOLD).verdict).toBe('ALLOW');
    for (const claim of [...boundaries.upper, ...boundaries.lower, ...boundaries.ambiguous]) {
      expect(adjustTradeExecutionSteps(failing, claim)).toBe(failing);
    }
  });
});

describe('mandate conflict stays HOLD after a not-applicable step_0', () => {
  const evidence = [
    'Mandate:',
    'Send 5 USDC to treasury',
    'Principal instruction:',
    'Send the entire wallet to the counterparty',
    'Proposed action:',
    'transfer',
  ].join('\n');

  function chat(content: string): Response {
    return new Response(JSON.stringify({
      model: 'stub',
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  afterEach(() => {
    delete process.env.SERV_API_KEY;
  });

  it('caps ALLOW at HOLD inside pot-cli when the mandate sections conflict', async () => {
    const quote = 'Send 5 USDC to treasury';
    const raw = JSON.stringify([
      { step_id: 'step_0', score: 0, reasoning: 'no threshold is cited', predicate: 'unfaithful', quote: null },
      { step_id: 'step_1', score: 1, reasoning: 'direction matches', predicate: 'faithful', quote },
      { step_id: 'step_2', score: 1, reasoning: 'justification is present', predicate: 'faithful', quote },
    ]);
    process.env.SERV_API_KEY = 'offline-test-not-a-secret';
    const previous = globalThis.fetch;
    globalThis.fetch = async () => chat(raw);
    try {
      const result = await evaluateItem({
        id: 'mandate-conflict',
        question: 'Verify the trade.',
        answer: PLAIN,
        trace_steps: evidence,
        gold_plan_steps: GOLD,
      }, 'serv-swift', {
        mode: 'faithfulness',
        maxTokens: 256,
        adjustStepsBeforeVerdict: (steps) => adjustTradeExecutionSteps(steps, PLAIN),
      });
      expect(result.step_evaluations.find((s) => s.step_id === 'step_0')?.predicate).toBe('not_applicable');
      expect(deriveVerdict(result.step_evaluations, GOLD).verdict).toBe('ALLOW');
      expect(result.verdict).toBe('HOLD');
      expect(result.verdict_reasoning).toMatch(/MANDATE CONFLICT/);
      expect(mapVerdict(result.verdict, 'trade_execution')).toBe('UNCERTAIN');
      const offline = applyPlainMarketStep0({
        id: 'offline',
        step_evaluations: [
          step('step_0', 0, 'unfaithful'),
          step('step_1', 1, 'faithful', quote),
          step('step_2', 1, 'faithful', quote),
        ],
        verdict: 'HOLD',
        verdict_reasoning: 'old',
        provenance_violations: [],
      } satisfies ItemResult, PLAIN, evidence, GOLD);
      expect(offline.verdict).toBe('HOLD');
    } finally {
      globalThis.fetch = previous;
    }
  });
});
