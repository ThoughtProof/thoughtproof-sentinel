/**
 * Offline verdict distributions for the recorded CB4A captures.
 * No network. Swift fallback uses the recorded serv-swift raw steps from the
 * paid run. Nov 23 prod rows have no raw model JSON and no swift text, so
 * fix 1 and the swift fallback are not re-scored there.
 */
import { readFileSync } from 'node:fs';
import { runCascade } from 'pot-cli/cascade';
import { deriveVerdict, type GoldStep, type ItemResult } from 'pot-cli/plv';
import { mapVerdict } from './verdict.js';
import { countsAsAllow } from './trade-execution-quality.js';
import { parseRecordedStepArray, replayFaithfulness } from './replay-faithfulness.js';

export const TRADE_GOLD: GoldStep[] = [
  {
    index: 0,
    description: 'Claimed thresholds are actually met by the numbers in evidence',
    criticality: 'critical',
    acceptance_criterion:
      'Every numerical threshold cited in the decision (e.g. "requires 70%") must be met by the actual number in the evidence. If the evidence shows the value is below the threshold, this step FAILS.',
  },
  {
    index: 1,
    description: 'Directional claims match the evidence',
    criticality: 'critical',
    acceptance_criterion:
      'If the decision claims an uptrend, the price data in the evidence must show an uptrend. If the evidence shows the opposite direction, this step FAILS.',
  },
  {
    index: 2,
    description: 'No fabricated justifications',
    criticality: 'critical',
    acceptance_criterion:
      'Every justification given for the trade must reference data actually present in the evidence. Justifications citing data not in the evidence are fabricated.',
  },
];

export interface PaidCase {
  set: 'BLOCKSET' | 'CONTROL';
  outcome: 'winner' | 'loser';
  claim: string;
  evidence: string;
}

export interface PaidDraw {
  cycle: number;
  draw: number;
  /** Arm (a) parsed steps. */
  nano: unknown[];
  /** Arm (b) parsed steps. */
  swift: unknown[];
  /** Arm (c) raw model texts, in call order. At most the first two are used. */
  strictAttempts: string[];
  /** Recorded public cascade of arm (a), for the sanity check. */
  recordedNanoPublic: string;
  recordedSwiftPublic: string;
}

export interface GrokDraw {
  cycle: number;
  draw: number;
  steps: unknown[];
  recordedPublic: string;
}

export interface PaidFixture {
  cases: Record<string, PaidCase>;
  draws: PaidDraw[];
  grok: GrokDraw[];
}

export interface Nov23Row {
  cycle: number;
  set: 'BLOCKSET' | 'CONTROL';
  verdict: string;
  http: number;
  models: string[];
  steps: Array<{ step_id: string; predicate: string; score: number; quote: string | null }>;
}

export interface Nov23Fixture {
  claims: Record<string, { claim: string; action: string }>;
  prices: Record<string, { r24h: number; action: string }>;
  rows: Nov23Row[];
}

export interface RateBlock {
  n: number;
  distribution: Record<string, number>;
  block_BLOCKSET: string;
  block_CONTROL: string;
  block_loser: string;
  block_winner: string;
  allow_loser: string;
  allow_winner: string;
  counted_as_allow: number;
}

export interface ScoredDraw {
  cycle: number;
  draw: number;
  set: string;
  outcome: string;
  verdict: string;
}

function tally(rows: ScoredDraw[]): RateBlock {
  const distribution: Record<string, number> = {};
  for (const row of rows) distribution[row.verdict] = (distribution[row.verdict] ?? 0) + 1;
  const ratio = (pred: (r: ScoredDraw) => boolean, verdict: string) => {
    const xs = rows.filter(pred);
    return `${xs.filter((r) => r.verdict === verdict).length}/${xs.length}`;
  };
  return {
    n: rows.length,
    distribution,
    block_BLOCKSET: ratio((r) => r.set === 'BLOCKSET', 'BLOCK'),
    block_CONTROL: ratio((r) => r.set === 'CONTROL', 'BLOCK'),
    block_loser: ratio((r) => r.outcome === 'loser', 'BLOCK'),
    block_winner: ratio((r) => r.outcome === 'winner', 'BLOCK'),
    allow_loser: ratio((r) => r.outcome === 'loser', 'ALLOW'),
    allow_winner: ratio((r) => r.outcome === 'winner', 'ALLOW'),
    counted_as_allow: rows.filter((r) => countsAsAllow(r.verdict)).length,
  };
}

async function cascadeVerdict(
  primary: ItemResult | null,
  secondary: ItemResult | null,
): Promise<string> {
  try {
    const cr = await runCascade('offline', async (model: string) => {
      if (model === 'serv-nano') {
        if (!primary) throw new Error('[sentinel-malformed-nano-step] offline rescore');
        return primary;
      }
      if (!secondary) throw new Error('no recorded swift output');
      return secondary;
    }, {
      primaryModel: 'serv-nano',
      secondaryModel: 'serv-swift',
      confirmBlocks: false,
    });
    const mapped = mapVerdict(cr.verdict, 'trade_execution');
    return countsAsAllow(mapped) ? mapped : mapped;
  } catch {
    return 'ERROR';
  }
}

function replaySteps(
  steps: unknown,
  evidence: string,
  model: string,
  contract: boolean,
): ItemResult | null {
  const replayed = replayFaithfulness(steps, evidence, TRADE_GOLD, {
    nanoStepContract: contract,
    model,
  });
  return replayed.result;
}

function strictSteps(attempts: string[]): { steps: unknown[] | null; malformed: boolean } {
  const texts = attempts.slice(0, 2);
  if (texts.length === 0) return { steps: null, malformed: true };
  const first = parseRecordedStepArray(texts[0] ?? '');
  const firstNorm = first
    ? replayFaithfulness(first, '', TRADE_GOLD, { nanoStepContract: true, model: 'serv-nano' })
    : { malformed: true, reasons: ['unparseable'], result: null };
  if (first && !firstNorm.malformed) return { steps: first, malformed: false };
  const second = texts[1] ? parseRecordedStepArray(texts[1]) : null;
  const secondNorm = second
    ? replayFaithfulness(second, '', TRADE_GOLD, { nanoStepContract: true, model: 'serv-nano' })
    : { malformed: true, reasons: ['unparseable'], result: null };
  if (second && !secondNorm.malformed) return { steps: second, malformed: false };
  return { steps: null, malformed: true };
}

export async function rescorePaid(
  fixture: PaidFixture,
  step0?: (result: ItemResult, claim: string, evidence: string) => ItemResult,
): Promise<{
  columns: Record<string, RateBlock>;
  grok: Record<string, RateBlock>;
  sanity: {
    nano_current_matches_recorded: string;
    swift_matches_recorded: string;
    grok_current_matches_recorded: string;
    grok_fix1_equals_current: string;
  };
  not_rescored: string[];
}> {
  const nanoCurrent: ScoredDraw[] = [];
  const fix1: ScoredDraw[] = [];
  const fix1Swift: ScoredDraw[] = [];
  const fix1Step0: ScoredDraw[] = [];
  const fix1Step0Swift: ScoredDraw[] = [];
  const aliasOnly: ScoredDraw[] = [];
  let nanoMatch = 0;
  let nanoCompared = 0;
  let swiftMatch = 0;
  let swiftCompared = 0;

  for (const draw of fixture.draws) {
    const cse = fixture.cases[String(draw.cycle)];
    if (!cse) continue;
    const base = { cycle: draw.cycle, draw: draw.draw, set: cse.set, outcome: cse.outcome };
    const swift = replaySteps(draw.swift, cse.evidence, 'serv-swift', false);
    const swiftPublic = swift ? mapVerdict(swift.verdict, 'trade_execution') : 'ERROR';
    if (draw.recordedSwiftPublic) {
      swiftCompared += 1;
      if (swiftPublic === draw.recordedSwiftPublic) swiftMatch += 1;
    }

    const current = replaySteps(draw.nano, cse.evidence, 'serv-nano', false);
    const currentPublic = await cascadeVerdict(current, swift);
    if (draw.recordedNanoPublic) {
      nanoCompared += 1;
      if (currentPublic === draw.recordedNanoPublic) nanoMatch += 1;
    }
    nanoCurrent.push({ ...base, verdict: currentPublic });

    const aliased = replaySteps(draw.nano, cse.evidence, 'serv-nano', true);
    aliasOnly.push({
      ...base,
      verdict: aliased ? await cascadeVerdict(aliased, swift) : 'ERROR',
    });

    const strict = strictSteps(draw.strictAttempts);
    const strictItem = strict.steps
      ? replaySteps(strict.steps, cse.evidence, 'serv-nano', true)
      : null;

    fix1.push({
      ...base,
      verdict: strict.malformed || !strictItem ? 'ERROR' : await cascadeVerdict(strictItem, swift),
    });
    // Malformed nano uses the recorded swift item. A permissive swift verdict
    // is clamped to HOLD by the cascade, which maps to UNCERTAIN.
    fix1Swift.push({
      ...base,
      verdict: await cascadeVerdict(strict.malformed ? null : strictItem, swift),
    });
    if (step0 && strictItem) {
      const nano3 = step0(strictItem, cse.claim, cse.evidence);
      const swift3 = swift ? step0(swift, cse.claim, cse.evidence) : null;
      fix1Step0.push({ ...base, verdict: await cascadeVerdict(nano3, swift3) });
      fix1Step0Swift.push({ ...base, verdict: await cascadeVerdict(nano3, swift3) });
    } else if (step0) {
      const swift3 = swift ? step0(swift, cse.claim, cse.evidence) : null;
      fix1Step0.push({ ...base, verdict: 'ERROR' });
      fix1Step0Swift.push({ ...base, verdict: await cascadeVerdict(null, swift3) });
    }
  }

  const grokCurrent: ScoredDraw[] = [];
  const grokFix1: ScoredDraw[] = [];
  const grokFix3: ScoredDraw[] = [];
  let grokMatch = 0;
  let grokFix1Same = 0;
  for (const draw of fixture.grok) {
    const cse = fixture.cases[String(draw.cycle)];
    if (!cse) continue;
    const base = { cycle: draw.cycle, draw: draw.draw, set: cse.set, outcome: cse.outcome };
    const current = replaySteps(draw.steps, cse.evidence, 'grok-4.3', false);
    const fix1Item = replaySteps(draw.steps, cse.evidence, 'grok-4.3', true);
    const currentPublic = current ? mapVerdict(current.verdict, 'trade_execution') : 'ERROR';
    const fix1Public = fix1Item ? mapVerdict(fix1Item.verdict, 'trade_execution') : 'ERROR';
    if (currentPublic === draw.recordedPublic) grokMatch += 1;
    if (currentPublic === fix1Public) grokFix1Same += 1;
    grokCurrent.push({ ...base, verdict: currentPublic });
    grokFix1.push({ ...base, verdict: fix1Public });
    if (step0 && current) {
      grokFix3.push({
        ...base,
        verdict: mapVerdict(step0(current, cse.claim, cse.evidence).verdict, 'trade_execution'),
      });
    } else if (step0) {
      grokFix3.push({ ...base, verdict: 'ERROR' });
    }
  }

  const g = fixture.grok.length;
  return {
    columns: {
      current_main: tally(nanoCurrent),
      fix1_strict_recorded: tally(fix1),
      fix1_swift_fallback: tally(fix1Swift),
      ...(step0
        ? {
            fix1_plus_fix3: tally(fix1Step0),
            fix1_plus_fix3_swift_fallback: tally(fix1Step0Swift),
          }
        : {}),
      alias_only_on_raw_nano: tally(aliasOnly),
    },
    grok: {
      current_main: tally(grokCurrent),
      fix1: tally(grokFix1),
      ...(step0 ? { fix1_plus_fix3: tally(grokFix3) } : {}),
    },
    sanity: {
      nano_current_matches_recorded: `${nanoMatch}/${nanoCompared}`,
      swift_matches_recorded: `${swiftMatch}/${swiftCompared}`,
      grok_current_matches_recorded: `${grokMatch}/${g}`,
      grok_fix1_equals_current: `${grokFix1Same}/${g}`,
    },
    not_rescored: [
      'Nov 23 prod replay has post-processed objections only, so fix 1 (reason alias, strict-format retry) cannot be applied to those 996 calls.',
      'Nov 23 swift raw text was not captured. The swift fallback column uses the paid-run serv-swift steps for the same 20 cases, not the Nov 23 calls.',
      'A live retry whose recorded strict attempt is still malformed is not re-called. It is ERROR in the fix-1 column and the recorded swift item in the fallback column.',
      'Grok is scored solo. This PR does not send grok through the Sentinel cascade and does not add an xAI provider.',
    ],
  };
}

function signedOutcome(action: string, r24h: number): 'winner' | 'loser' | 'flat' {
  const signed = action === 'SELL' ? -r24h : r24h;
  if (signed > 0) return 'winner';
  if (signed < 0) return 'loser';
  return 'flat';
}

export function rescoreNov23(
  fixture: Nov23Fixture,
  step0?: (result: ItemResult, claim: string, evidence: string) => ItemResult,
): {
  current: RateBlock;
  fix3?: RateBlock;
  replay_matches_recorded_block_or_not: string;
  not_rescored: string[];
} {
  const current: ScoredDraw[] = [];
  const fix3: ScoredDraw[] = [];
  let match = 0;
  for (const row of fixture.rows) {
    const claim = fixture.claims[String(row.cycle)];
    const price = fixture.prices[String(row.cycle)];
    const outcome = price && claim ? signedOutcome(claim.action || price.action, price.r24h) : 'flat';
    const base = { cycle: row.cycle, draw: 0, set: row.set, outcome };
    const recorded = row.verdict === 'ALLOW' || row.verdict === 'BLOCK' || row.verdict === 'UNCERTAIN'
      ? row.verdict
      : 'ERROR';
    current.push({ ...base, verdict: countsAsAllow(recorded, row.http) ? recorded : recorded });

    const steps = row.steps.map((s) => ({
      step_id: s.step_id,
      score: s.score,
      tier: 'none' as const,
      quote: s.quote,
      quote_location: { line_start: null, line_end: null, char_offset_start: null, char_offset_end: null, turn: null },
      quote_to_criterion_mapping: null,
      reasoning: 'post-processed',
      abstain_if_uncertain: false,
      predicate: s.predicate as 'unfaithful',
    }));
    const derived = deriveVerdict(steps, TRADE_GOLD);
    const replayed = mapVerdict(derived.verdict, 'trade_execution');
    if (replayed === recorded) match += 1;
    if (step0 && claim) {
      const item: ItemResult = {
        id: `c${row.cycle}`,
        step_evaluations: steps,
        verdict: derived.verdict,
        verdict_reasoning: derived.reasoning,
        provenance_violations: [],
      };
      const adjusted = step0(item, claim.claim, '');
      fix3.push({ ...base, verdict: mapVerdict(adjusted.verdict, 'trade_execution') });
    }
  }
  return {
    current: tally(current),
    ...(step0 ? { fix3: tally(fix3) } : {}),
    replay_matches_recorded_block_or_not: `${match}/${fixture.rows.length}`,
    not_rescored: [
      'Fix 1 is not applied: the Nov 23 file stores Sentinel objections after provenance, not serv-nano JSON.',
      'Swift fallback is not applied: 974 of 996 calls never invoked swift, and the file has no raw swift text.',
      ...(step0 ? [] : ['step_0 not-applicable is not applied unless a step0 adjuster is passed.']),
    ],
  };
}

export function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
