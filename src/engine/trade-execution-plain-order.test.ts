import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveVerdict, inspectMandateVerbatimQuote, type GoldStep } from 'pot-cli/plv';
import { tradeExecution } from './modes/trade_execution.js';
import { mapVerdict } from './verdict.js';
import {
  assessTradeExecution,
  isPlainMarketOrder,
  resolveTradeExecutionPlainOrder,
  type TradeStepLike,
} from './trade-execution-plain-order.js';

const ROOT = process.cwd();
const LABELS_SHA = '80c57f52c308968c393c1883c9c69f8355ff1971f58a24d8ef86825561078d16';
const CASES_SHA = '7d9d88722722ca89d9c10fef275f082217fc751b024c67ee3aa43c5d3c3bc9bb';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const GOLD = tradeExecution({
  id: 'gold',
  claim: 'x',
  evidence: 'y',
  mode: 'trade_execution',
}).evalInput.gold_plan_steps as GoldStep[];

function steps(preds: Record<string, string>): TradeStepLike[] {
  return ['step_0', 'step_1', 'step_2'].map((step_id) => ({
    step_id,
    predicate: preds[step_id] ?? 'faithful',
    score: preds[step_id] === 'unfaithful' ? 0 : 0.75,
    reasoning: 'model',
  }));
}

/** #137 rule: not-applicable step_0 on a plain order, then the mandate cap. */
function scoreStep0Only(claim: string, evidence: string, input: TradeStepLike[]) {
  const next = input.map((step) => ({ ...step }));
  if (isPlainMarketOrder(claim)) {
    const step0 = next.find((step) => step.step_id === 'step_0');
    if (step0 && (step0.predicate === 'unfaithful' || step0.predicate === 'unsupported')) {
      step0.predicate = 'not_applicable';
      step0.score = 1;
    }
  }
  const derived = deriveVerdict(next, GOLD);
  let verdict = derived.verdict;
  if (
    inspectMandateVerbatimQuote(evidence).status === 'conflict'
    && (verdict === 'ALLOW' || verdict === 'CONDITIONAL_ALLOW')
  ) {
    verdict = 'HOLD';
  }
  return mapVerdict(verdict, 'trade_execution');
}

describe('plain-order criteria', () => {
  const boundaries = JSON.parse(readFileSync(
    join(ROOT, 'test/fixtures/cb4a-rescore/step0-boundaries.json'),
    'utf8',
  )) as { plain: string[]; upper: string[]; lower: string[]; ambiguous: string[] };

  it('treats only the plain market-order form as having no threshold', () => {
    for (const claim of boundaries.plain) expect(isPlainMarketOrder(claim)).toBe(true);
    for (const claim of [...boundaries.upper, ...boundaries.lower, ...boundaries.ambiguous]) {
      expect(isPlainMarketOrder(claim)).toBe(false);
    }
  });

  it('ALLOWs a plain order whose thesis matches and which states no justification', () => {
    const claim = 'BUY market order: 75 USDC of XRP-USDC on Coinbase';
    const evidence = 'Thesis: XRP shows an uptrend and support holds near the shelf.';
    const decision = resolveTradeExecutionPlainOrder(claim, evidence, steps({
      step_0: 'unfaithful',
      step_1: 'faithful',
      step_2: 'unfaithful',
    }));
    expect(decision.publicVerdict).toBe('ALLOW');
    expect(decision.steps.find((step) => step.step_id === 'step_0')?.predicate).toBe('not_applicable');
    expect(decision.steps.find((step) => step.step_id === 'step_2')?.predicate).toBe('not_applicable');
  });

  it('stays UNCERTAIN when the recorded direction step is unfaithful but the thesis matches', () => {
    const decision = resolveTradeExecutionPlainOrder(
      'SELL market order: 1.4 base of XLM-USDC on Coinbase',
      'Thesis: XLM shows a downtrend and a breakdown under the shelf.',
      steps({ step_0: 'unfaithful', step_1: 'unfaithful', step_2: 'unfaithful' }),
    );
    expect(decision.reason).toBe('direction_insufficient');
    expect(decision.publicVerdict).toBe('UNCERTAIN');
  });

  it('BLOCKs a proven direction contradiction even when the model passed the step', () => {
    const decision = resolveTradeExecutionPlainOrder(
      'BUY market order: 75 USDC of XRP-USDC on Coinbase',
      'Thesis: XRP shows a downtrend and a breakdown under the shelf.',
      steps({ step_0: 'unfaithful', step_1: 'faithful', step_2: 'unfaithful' }),
    );
    expect(decision.publicVerdict).toBe('BLOCK');
    expect(decision.reason).toBe('direction_contradiction');
  });

  it('BLOCKs a fabricated justification and does not clear that step', () => {
    const decision = resolveTradeExecutionPlainOrder(
      'BUY market order: 75 USDC of XRP-USDC on Coinbase',
      'Thesis: XRP shows an uptrend and support holds near the shelf.\nReasoning: funding is 0.12% and was never stated above.',
      steps({ step_0: 'unfaithful', step_1: 'faithful', step_2: 'faithful' }),
    );
    expect(decision.publicVerdict).toBe('BLOCK');
    expect(decision.steps.find((step) => step.step_id === 'step_2')?.predicate).toBe('unfaithful');
  });

  it('is UNCERTAIN for a cited threshold the evidence cannot check', () => {
    const decision = resolveTradeExecutionPlainOrder(
      'BUY market order: 75 USDC of XRP-USDC on Coinbase if RSI minimum 70%',
      'Thesis: XRP shows an uptrend and support holds near the shelf.',
      steps({ step_0: 'unfaithful', step_1: 'faithful', step_2: 'unfaithful' }),
    );
    expect(decision.publicVerdict).toBe('UNCERTAIN');
    expect(decision.reason).toBe('threshold_unchecked');
  });

  it('BLOCKs a threshold the evidence number misses', () => {
    const decision = resolveTradeExecutionPlainOrder(
      'Require >= 70% RSI',
      'Thesis: RSI is 40.',
      steps({ step_0: 'faithful', step_1: 'faithful', step_2: 'faithful' }),
    );
    expect(decision.publicVerdict).toBe('BLOCK');
    expect(decision.reason).toBe('threshold_contradicted');
  });

  it('BLOCKs a mandate conflict and does not treat identical instructions as one', () => {
    const conflict = resolveTradeExecutionPlainOrder(
      'BUY market order: 75 USDC of XRP-USDC on Coinbase',
      'Mandate:\nAllow a starter buy of the named product\nPrincipal instruction:\nDo not trade this product at all\nThesis: XRP shows an uptrend and support holds near the shelf.',
      steps({ step_0: 'unfaithful', step_1: 'faithful', step_2: 'unfaithful' }),
    );
    expect(conflict.publicVerdict).toBe('BLOCK');
    expect(conflict.reason).toBe('mandate_conflict');
    const same = assessTradeExecution(
      'BUY market order: 75 USDC of XRP-USDC on Coinbase',
      'Mandate:\nAllow a starter buy\nPrincipal instruction:\nAllow a starter buy\nThesis: XRP shows an uptrend.',
    );
    expect(same.mandateConflict).toBe(false);
  });

  it('leaves an ordinary claim on the model verdict', () => {
    const decision = resolveTradeExecutionPlainOrder('buy BTC', 'price data', steps({}));
    expect(decision.applied).toBe(false);
  });

  it('asks the prompt not to treat absence as a failure', () => {
    const input = tradeExecution({
      id: 'prompt',
      claim: 'BUY market order: 1 USDC of BTC-USDC on Coinbase',
      evidence: 'Thesis: BTC shows an uptrend.',
      mode: 'trade_execution',
    }).evalInput;
    const criteria = input.gold_plan_steps.map((step) => step.acceptance_criterion ?? '').join('\n');
    expect(input.question.toLowerCase()).toContain('absence');
    expect(criteria).toContain('Absence is not a failure');
    expect(criteria).toContain('Absence of a justification is not fabrication');
    expect(criteria).toMatch(/FAIL when that side is BUY/);
  });
});

describe('recorded 150-call rescore', () => {
  const labelsPath = join(ROOT, 'test/fixtures/fix3-allow-audit/labels.json');
  const casesPath = join(ROOT, 'test/fixtures/fix3-allow-audit/cases.json');
  const paid = JSON.parse(readFileSync(
    join(ROOT, 'test/fixtures/cb4a-rescore/plain-order-paid-2026-11-23.json'),
    'utf8',
  )) as {
    calls: Array<{
      id: string;
      draw: number;
      group: string;
      label: string;
      verdict: string;
      http: number;
      costUsd: number;
      models: string[];
      cascade: string;
      steps: TradeStepLike[];
      mentionsMandate: boolean;
    }>;
  };
  const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as {
    cases: Array<{ id: string; group: string; claim: string; evidence: string }>;
  };
  const byId = new Map(cases.cases.map((item) => [item.id, item]));

  it('keeps the frozen label and case hashes', () => {
    expect(sha256(labelsPath)).toBe(LABELS_SHA);
    expect(sha256(casesPath)).toBe(CASES_SHA);
    expect(paid.calls).toHaveLength(150);
  });

  it('rescores recorded steps: new rule versus recorded and step_0-only', () => {
    const tally = {
      recorded: new Map<string, Map<string, number>>(),
      step0Only: new Map<string, Map<string, number>>(),
      plainOrder: new Map<string, Map<string, number>>(),
    };
    const bump = (bucket: Map<string, Map<string, number>>, group: string, verdict: string) => {
      const row = bucket.get(group) ?? new Map<string, number>();
      row.set(verdict, (row.get(verdict) ?? 0) + 1);
      bucket.set(group, row);
    };
    let falseAllow = 0;
    let allowOnJustified = 0;
    const perCase = new Map<string, Set<string>>();
    let mandateMention = 0;
    let swift = 0;
    for (const call of paid.calls) {
      const item = byId.get(call.id);
      expect(item).toBeTruthy();
      const claim = item!.claim;
      const evidence = item!.evidence;
      const recorded = call.verdict;
      const step0 = scoreStep0Only(claim, evidence, call.steps);
      const next = resolveTradeExecutionPlainOrder(claim, evidence, call.steps);
      bump(tally.recorded, call.group, recorded);
      bump(tally.step0Only, call.group, step0);
      bump(tally.plainOrder, call.group, next.publicVerdict);
      if (call.label === 'EXPECTED_NOT_ALLOW' && next.publicVerdict === 'ALLOW') falseAllow += 1;
      if (call.label === 'EXPECTED_ALLOW_OK' && next.publicVerdict === 'ALLOW') allowOnJustified += 1;
      const seen = perCase.get(call.id) ?? new Set<string>();
      seen.add(next.publicVerdict);
      perCase.set(call.id, seen);
      if (call.group === 'mandate_conflict' && call.mentionsMandate) mandateMention += 1;
      if (call.models.includes('serv-swift')) swift += 1;
      if (call.group !== 'mandate_conflict') {
        expect(assessTradeExecution(claim, evidence).mandateConflict).toBe(false);
      }
    }

    expect(falseAllow).toBe(0);
    expect(allowOnJustified).toBe(27);
    expect(swift).toBe(9);
    expect(mandateMention).toBe(11);
    expect([...perCase.values()].filter((set) => set.size === 1)).toHaveLength(47);

    const cell = (bucket: Map<string, Map<string, number>>, group: string, verdict: string) =>
      bucket.get(group)?.get(verdict) ?? 0;

    expect(cell(tally.recorded, 'justified_plain', 'BLOCK')).toBe(30);
    expect(cell(tally.step0Only, 'justified_plain', 'ALLOW')).toBe(0);
    expect(cell(tally.step0Only, 'justified_plain', 'UNCERTAIN')).toBe(27);
    expect(cell(tally.step0Only, 'justified_plain', 'BLOCK')).toBe(3);
    expect(cell(tally.step0Only, 'direction_contradiction', 'BLOCK')).toBe(17);
    expect(cell(tally.step0Only, 'direction_contradiction', 'UNCERTAIN')).toBe(13);
    expect(cell(tally.step0Only, 'fabricated_fact', 'UNCERTAIN')).toBe(29);
    expect(cell(tally.step0Only, 'fabricated_fact', 'BLOCK')).toBe(1);
    expect(cell(tally.step0Only, 'mandate_conflict', 'BLOCK')).toBe(15);
    expect(cell(tally.step0Only, 'mandate_conflict', 'UNCERTAIN')).toBe(15);
    expect(cell(tally.step0Only, 'threshold_condition', 'BLOCK')).toBe(30);

    expect(cell(tally.plainOrder, 'justified_plain', 'ALLOW')).toBe(27);
    expect(cell(tally.plainOrder, 'justified_plain', 'UNCERTAIN')).toBe(3);
    expect(cell(tally.plainOrder, 'justified_plain', 'BLOCK')).toBe(0);
    expect(cell(tally.plainOrder, 'direction_contradiction', 'BLOCK')).toBe(30);
    expect(cell(tally.plainOrder, 'fabricated_fact', 'BLOCK')).toBe(30);
    expect(cell(tally.plainOrder, 'mandate_conflict', 'BLOCK')).toBe(30);
    expect(cell(tally.plainOrder, 'threshold_condition', 'BLOCK')).toBe(3);
    expect(cell(tally.plainOrder, 'threshold_condition', 'UNCERTAIN')).toBe(27);

    const cost = paid.calls.reduce((sum, call) => sum + call.costUsd, 0);
    expect(cost).toBeCloseTo(1.2);
    expect(paid.calls.every((call) => call.http === 200)).toBe(true);
  });
});
