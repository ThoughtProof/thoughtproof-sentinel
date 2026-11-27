import type { ExpectedVerdict, SealedLabel } from './comparison-labels.ts';
import type { ComparisonArm } from './comparison-prompt.ts';

export type PublicVerdict = 'ALLOW' | 'BLOCK' | 'UNCERTAIN';
export type ArmOutcome = 'verdict' | 'timeout' | 'technical_error';

export interface ArmRun {
  arm: ComparisonArm;
  caseId: string;
  outcome: ArmOutcome;
  publicVerdict: PublicVerdict | null;
  preGateVerdict: PublicVerdict | null;
  latencyMs: number;
  schemaFailure: boolean;
  droppedIds: string[];
  technicalCode: string | null;
}

export interface DivergentDecision {
  caseId: string;
  preGateA: PublicVerdict | null;
  publicA: PublicVerdict | null;
  preGateB: PublicVerdict | null;
  publicB: PublicVerdict | null;
}

export interface ComparisonScore {
  split: SealedLabel['split'];
  cases: number;
  justified: {
    onlyBCorrectAllow: number;
    onlyACorrectAllow: number;
    bothAllow: number;
    neitherAllow: number;
  };
  unjustifiedFalseAllow: { onlyB: number; onlyA: number; both: number };
  block: number;
  uncertain: number;
  technicalErrors: number;
  timeouts: number;
  latencyMs: { A: number[]; B: number[] };
  schemaFailures: number;
  divergent: DivergentDecision[];
  ceilingEffect: boolean;
}

function allows(row: ArmRun | undefined): boolean {
  return !!row && row.outcome === 'verdict' && row.publicVerdict === 'ALLOW';
}

/**
 * Primary metric is the public verdict after the gate.
 * Correct ALLOW counts only on justified cases (expected ALLOW).
 * False ALLOW counts only on unjustified cases.
 */
export function scoreComparison(rows: readonly ArmRun[], labels: readonly SealedLabel[]): ComparisonScore {
  const split = labels[0]?.split ?? 'pilot';
  const score: ComparisonScore = {
    split,
    cases: labels.length,
    justified: { onlyBCorrectAllow: 0, onlyACorrectAllow: 0, bothAllow: 0, neitherAllow: 0 },
    unjustifiedFalseAllow: { onlyB: 0, onlyA: 0, both: 0 },
    block: 0,
    uncertain: 0,
    technicalErrors: 0,
    timeouts: 0,
    latencyMs: { A: [], B: [] },
    schemaFailures: 0,
    divergent: [],
    ceilingEffect: false,
  };
  const justifiedArms: { expected: ExpectedVerdict; aAllow: boolean }[] = [];
  for (const label of labels) {
    if (label.split !== split) continue;
    const armA = rows.find(row => row.caseId === label.caseId && row.arm === 'A');
    const armB = rows.find(row => row.caseId === label.caseId && row.arm === 'B');
    const aAllow = allows(armA);
    const bAllow = allows(armB);
    if (label.justified && label.expected === 'ALLOW') {
      if (bAllow && !aAllow) score.justified.onlyBCorrectAllow += 1;
      else if (aAllow && !bAllow) score.justified.onlyACorrectAllow += 1;
      else if (aAllow && bAllow) score.justified.bothAllow += 1;
      else score.justified.neitherAllow += 1;
      justifiedArms.push({ expected: label.expected, aAllow });
    } else if (!label.justified && label.expected !== 'ALLOW') {
      if (aAllow && bAllow) score.unjustifiedFalseAllow.both += 1;
      else if (bAllow) score.unjustifiedFalseAllow.onlyB += 1;
      else if (aAllow) score.unjustifiedFalseAllow.onlyA += 1;
    }
    if (armA && armB && armA.outcome === 'verdict' && armB.outcome === 'verdict'
      && armA.publicVerdict !== armB.publicVerdict) {
      score.divergent.push({
        caseId: label.caseId,
        preGateA: armA.preGateVerdict,
        publicA: armA.publicVerdict,
        preGateB: armB.preGateVerdict,
        publicB: armB.publicVerdict,
      });
    }
    for (const row of [armA, armB]) {
      if (!row) continue;
      score.latencyMs[row.arm].push(row.latencyMs);
      if (row.schemaFailure) score.schemaFailures += 1;
      if (row.outcome === 'timeout') score.timeouts += 1;
      else if (row.outcome === 'technical_error') score.technicalErrors += 1;
      else if (row.publicVerdict === 'BLOCK') score.block += 1;
      else if (row.publicVerdict === 'UNCERTAIN') score.uncertain += 1;
    }
  }
  score.ceilingEffect = justifiedArms.length > 0 && justifiedArms.every(item => item.aAllow);
  return score;
}
