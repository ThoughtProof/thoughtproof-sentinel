/**
 * OFF vs ON for the held-back step_0 rule.
 * Step inputs are SYNTHETIC. They are not model output.
 * Labels are the frozen file; this test does not relabel.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveVerdict, inspectMandateVerbatimQuote, type StepEvaluation } from 'pot-cli/plv';
import { mapVerdict } from './verdict.js';
import { TRADE_GOLD } from './cb4a-offline-rescore.js';
import { adjustTradeExecutionSteps } from './trade-execution-step0.js';

const dir = join(process.cwd(), 'test/fixtures/fix3-allow-audit');

interface AuditCase {
  id: string;
  group: string;
  claim: string;
  evidence: string;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function step(id: string, failing: boolean): StepEvaluation {
  return {
    step_id: id,
    score: failing ? 0 : 1,
    tier: failing ? 'none' : 'strong',
    quote: failing ? null : 'shelf',
    quote_location: { line_start: null, line_end: null, char_offset_start: null, char_offset_end: null, turn: null },
    quote_to_criterion_mapping: null,
    reasoning: failing ? 'SYNTHETIC failing step, not model output.' : 'SYNTHETIC passing step, not model output.',
    abstain_if_uncertain: false,
    predicate: failing ? 'unfaithful' : 'faithful',
  };
}

/** SYNTHETIC step results. See synthetic-steps.json. */
function syntheticSteps(group: string): StepEvaluation[] {
  if (group === 'direction_contradiction') {
    return [step('step_0', true), step('step_1', true), step('step_2', false)];
  }
  if (group === 'fabricated_fact') {
    return [step('step_0', true), step('step_1', false), step('step_2', true)];
  }
  return [step('step_0', true), step('step_1', false), step('step_2', false)];
}

function publicVerdict(steps: StepEvaluation[], evidence: string): 'ALLOW' | 'BLOCK' | 'UNCERTAIN' {
  const derived = deriveVerdict(steps, TRADE_GOLD);
  let verdict = derived.verdict;
  if (
    inspectMandateVerbatimQuote(evidence).status === 'conflict'
    && (verdict === 'ALLOW' || verdict === 'CONDITIONAL_ALLOW')
  ) {
    verdict = 'HOLD';
  }
  return mapVerdict(verdict, 'trade_execution');
}

describe('fix 3 allow audit on frozen labels', () => {
  it('matches the frozen hashes and reports OFF vs ON by group', () => {
    const casesPath = join(dir, 'cases.json');
    const labelsPath = join(dir, 'labels.json');
    const frozen = readFileSync(join(dir, 'LABELS_FROZEN.md'), 'utf8');
    expect(frozen).toContain(sha256(casesPath));
    expect(frozen).toContain(sha256(labelsPath));
    const cases = (JSON.parse(readFileSync(casesPath, 'utf8')) as { cases: AuditCase[] }).cases;
    const labels = JSON.parse(readFileSync(labelsPath, 'utf8')) as { label_for_id: Record<string, string> };
    const synthetic = JSON.parse(readFileSync(join(dir, 'synthetic-steps.json'), 'utf8')) as { source: string };
    expect(synthetic.source).toBe('SYNTHETIC');

    const groups = [...new Set(cases.map((c) => c.group))];
    const report: Record<string, unknown> = {};
    for (const group of groups) {
      const rows = cases.filter((c) => c.group === group);
      const tally = (on: boolean) => {
        const counts = { ALLOW: 0, BLOCK: 0, UNCERTAIN: 0 };
        let falseAllow = 0;
        let missedAllow = 0;
        for (const row of rows) {
          const label = labels.label_for_id[row.id];
          const steps = on
            ? adjustTradeExecutionSteps(syntheticSteps(group), row.claim)
            : syntheticSteps(group);
          const verdict = publicVerdict(steps, row.evidence);
          counts[verdict] += 1;
          if (verdict === 'ALLOW' && label === 'EXPECTED_NOT_ALLOW') falseAllow += 1;
          if (verdict !== 'ALLOW' && label === 'EXPECTED_ALLOW_OK') missedAllow += 1;
        }
        return { ...counts, false_ALLOW: falseAllow, missed_ALLOW: missedAllow, n: rows.length };
      };
      const off = tally(false);
      const on = tally(true);
      report[group] = { off, on, inputs: 'SYNTHETIC' };
      expect(off.false_ALLOW).toBe(0);
      expect(on.false_ALLOW).toBe(0);
      if (group === 'justified_plain') {
        expect(off.missed_ALLOW).toBe(rows.length);
        expect(on.ALLOW).toBe(rows.length);
        expect(on.missed_ALLOW).toBe(0);
      } else {
        expect(on.ALLOW).toBe(0);
        expect(off.ALLOW).toBe(0);
      }
    }
    if (process.env.CB4A_RESCORE_PRINT === '1') {
      console.log(JSON.stringify({ synthetic: true, groups: report }, null, 2));
    }
  });
});
