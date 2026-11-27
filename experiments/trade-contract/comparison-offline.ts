import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { COMPARISON_CASES, casesFor } from './comparison-cases.ts';
import { labelsFor } from './comparison-labels.ts';
import { deterministicPrecheckPasses } from './comparison-precheck.ts';
import { scoreComparison, type ArmRun } from './comparison-evaluate.ts';
import { runRecordedArm, type RecordedExchange } from './comparison-run.ts';
import { paidPilotRefusalReason, runPaidPilot } from './comparison-paid.ts';
import { execFileSync } from 'node:child_process';
import { pilotPlan, schemaSmokePlan, tradeOrderPlan } from './comparison-plan.ts';
import { COMPARISON_BASELINE, type ComparisonArm } from './comparison-prompt.ts';
import { SCHEMA_SMOKE_PAID, SCHEMA_SMOKE_SOFT_CAP_NOTE, runSchemaSmoke } from './comparison-smoke.ts';
import { runTradeOrderDev, tradeOrderSelectorConflict } from './comparison-trade-order.ts';

export function precheckSummary(): { pilot: number; dev: number; failed: string[] } {
  return {
    pilot: casesFor('pilot').length,
    dev: casesFor('dev').length,
    failed: COMPARISON_CASES.filter(item => !deterministicPrecheckPasses(item.precheck)).map(item => item.caseId),
  };
}

interface RecordedFile {
  runs: {
    arm: ComparisonArm;
    caseId: string;
    recorded: RecordedExchange;
  }[];
}

function scoreRecorded(file: RecordedFile): ReturnType<typeof scoreComparison> {
  const labels = labelsFor('pilot');
  const rows: ArmRun[] = file.runs.map(item => {
    const found = COMPARISON_CASES.find(candidate => candidate.caseId === item.caseId);
    if (!found) throw new Error('UNKNOWN_CASE');
    return runRecordedArm({
      arm: item.arm,
      caseId: item.caseId,
      documents: found.documents,
      recorded: item.recorded,
      costCapUsd: Number(process.env.GROUNDED_CRITIC_COST_CAP_USD ?? '5'),
    });
  });
  return scoreComparison(rows, labels);
}

export function testedHead(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export interface DispatchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Offline command router. Tests pass a mock fetch and a fake env.
 * A real key is never read from disk; the env argument is the only source.
 */
export async function dispatchComparison(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<DispatchResult> {
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  if (tradeOrderSelectorConflict(args)) {
    stderr = 'Contradictory selectors. No request was sent.\n';
    return { exitCode: 3, stdout, stderr };
  }
  if (args.includes('--trade-order-dev') && !args.includes('--paid')) {
    stdout = `${JSON.stringify(tradeOrderPlan(testedHead()))}\n`;
    return { exitCode, stdout, stderr };
  }
  if (args.includes('--trade-order-dev') && args.includes('--paid')) {
    if (!env.XAI_API_KEY) {
      stderr = 'XAI_API_KEY is not set. No request was sent.\n';
      return { exitCode: 3, stdout, stderr };
    }
    stderr = `${SCHEMA_SMOKE_SOFT_CAP_NOTE}\n`;
    const saveAt = args.indexOf('--save-raw');
    const saveRawDir = saveAt >= 0 ? args[saveAt + 1] : undefined;
    if (saveAt >= 0 && !saveRawDir) throw new Error('SAVE_RAW_DIR');
    const report = await runTradeOrderDev(env, fetchImpl, { head: testedHead(), saveRawDir });
    stdout = `${JSON.stringify(report)}\n`;
    return { exitCode, stdout, stderr };
  }
  if (args.includes('--schema-smoke') && args.includes('--paid')) {
    if (!env.XAI_API_KEY) {
      stderr = 'XAI_API_KEY is not set. No request was sent.\n';
      return { exitCode: 3, stdout, stderr };
    }
    stderr = `${SCHEMA_SMOKE_SOFT_CAP_NOTE}\n`;
    const saveAt = args.indexOf('--save-raw');
    const saveRawDir = saveAt >= 0 ? args[saveAt + 1] : undefined;
    if (saveAt >= 0 && !saveRawDir) throw new Error('SAVE_RAW_DIR');
    const report = await runSchemaSmoke(env, fetchImpl, {
      softCapUsd: SCHEMA_SMOKE_PAID.budgetUsd,
      timeoutMs: SCHEMA_SMOKE_PAID.timeoutMs,
      maxCalls: SCHEMA_SMOKE_PAID.maxCalls,
      keyOnly: true,
      saveRawDir,
    });
    stdout = `${JSON.stringify(report)}\n`;
    return { exitCode, stdout, stderr };
  }
  if (args.includes('--schema-smoke')) {
    stdout = `${JSON.stringify(schemaSmokePlan())}\n`;
    return { exitCode, stdout, stderr };
  }
  if (args.includes('--paid')) {
    const reason = paidPilotRefusalReason(env);
    if (reason) {
      stderr = `Paid pilot refused (${reason}). No request was sent.\n`;
      return { exitCode: 3, stdout, stderr };
    }
    const runs = await runPaidPilot(env, fetchImpl);
    stdout = `${JSON.stringify({ baseline: COMPARISON_BASELINE, ...scoreComparison(runs, labelsFor('pilot')) })}\n`;
    return { exitCode, stdout, stderr };
  }
  if (args.includes('--plan')) {
    stdout = `${JSON.stringify({ pilot: pilotPlan(), schemaSmoke: schemaSmokePlan() })}\n`;
    return { exitCode, stdout, stderr };
  }
  const recordedFlag = args.indexOf('--recorded');
  if (recordedFlag >= 0) {
    const filePath = args[recordedFlag + 1];
    if (!filePath) throw new Error('RECORDED_PATH');
    const file = JSON.parse(readFileSync(filePath, 'utf8')) as RecordedFile;
    stdout = `${JSON.stringify(scoreRecorded(file))}\n`;
    return { exitCode, stdout, stderr };
  }
  const summary = precheckSummary();
  stdout = `${JSON.stringify(summary)}\n`;
  if (summary.failed.length > 0) exitCode = 3;
  return { exitCode, stdout, stderr };
}

async function main(): Promise<void> {
  const result = await dispatchComparison(process.argv.slice(2), process.env, fetch);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}

const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch(() => {
    process.stderr.write('Offline comparison failed before a verdict.\n');
    process.exitCode = 3;
  });
}
