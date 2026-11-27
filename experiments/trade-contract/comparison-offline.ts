import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { COMPARISON_CASES, casesFor } from './comparison-cases.ts';
import { labelsFor } from './comparison-labels.ts';
import { deterministicPrecheckPasses } from './comparison-precheck.ts';
import { scoreComparison, type ArmRun } from './comparison-evaluate.ts';
import { runRecordedArm, type RecordedExchange } from './comparison-run.ts';
import { paidPilotRefusalReason, runPaidPilot } from './comparison-paid.ts';
import { pilotPlan, schemaSmokePlan } from './comparison-plan.ts';
import { COMPARISON_BASELINE, type ComparisonArm } from './comparison-prompt.ts';
import { SCHEMA_SMOKE_PAID, SCHEMA_SMOKE_SOFT_CAP_NOTE, runSchemaSmoke } from './comparison-smoke.ts';

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--schema-smoke') && args.includes('--paid')) {
    if (!process.env.XAI_API_KEY) {
      process.stderr.write('XAI_API_KEY is not set. No request was sent.\n');
      process.exitCode = 3;
      return;
    }
    process.stderr.write(`${SCHEMA_SMOKE_SOFT_CAP_NOTE}\n`);
    const report = await runSchemaSmoke(process.env, fetch, {
      softCapUsd: SCHEMA_SMOKE_PAID.budgetUsd,
      timeoutMs: SCHEMA_SMOKE_PAID.timeoutMs,
      maxCalls: SCHEMA_SMOKE_PAID.maxCalls,
      keyOnly: true,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  if (args.includes('--schema-smoke')) {
    process.stdout.write(`${JSON.stringify(schemaSmokePlan())}\n`);
    return;
  }
  if (args.includes('--paid')) {
    const reason = paidPilotRefusalReason(process.env);
    if (reason) {
      process.stderr.write(`Paid pilot refused (${reason}). No request was sent.\n`);
      process.exitCode = 3;
      return;
    }
    const runs = await runPaidPilot(process.env);
    process.stdout.write(`${JSON.stringify({ baseline: COMPARISON_BASELINE, ...scoreComparison(runs, labelsFor('pilot')) })}\n`);
    return;
  }
  if (args.includes('--plan')) {
    process.stdout.write(`${JSON.stringify({ pilot: pilotPlan(), schemaSmoke: schemaSmokePlan() })}\n`);
    return;
  }
  const recordedFlag = args.indexOf('--recorded');
  if (recordedFlag >= 0) {
    const filePath = args[recordedFlag + 1];
    if (!filePath) throw new Error('RECORDED_PATH');
    const file = JSON.parse(readFileSync(filePath, 'utf8')) as RecordedFile;
    process.stdout.write(`${JSON.stringify(scoreRecorded(file))}\n`);
    return;
  }
  const summary = precheckSummary();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.failed.length > 0) process.exitCode = 3;
}

const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch(() => {
    process.stderr.write('Offline comparison failed before a verdict.\n');
    process.exitCode = 3;
  });
}
