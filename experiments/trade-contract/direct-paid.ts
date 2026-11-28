import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sendPaidExchange, type PaidEnv } from './comparison-paid.ts';
import { createComparisonBudget } from './direct-budget.ts';
import { runDirectComparison, DIRECT_MAX_CALLS, DIRECT_RETRIES, DIRECT_SYSTEM_MS } from './direct-run.ts';
import type { HoldoutCase } from './direct-holdout-plan.ts';

const BLOCKED_FINGERPRINT = '6d2c6400b115';

function keyAllowed(env: PaidEnv): { ok: true } | { ok: false; reason: string } {
  const key = env.XAI_API_KEY ?? '';
  if (!key) return { ok: false, reason: 'XAI_API_KEY is not set' };
  const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 12);
  if (fingerprint === BLOCKED_FINGERPRINT) return { ok: false, reason: 'refusing the blocked credential fingerprint' };
  return { ok: true };
}

function loadCases(zipPath: string): HoldoutCase[] {
  const dir = join(tmpdir(), `direct-paid-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const unpacked = spawnSync('unzip', ['-qo', zipPath, '-d', dir], { encoding: 'utf8' });
  if (unpacked.status !== 0) throw new Error('HOLD_OUT_ZIP_UNREADABLE');
  const parsed = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8')) as { cases?: HoldoutCase[] } | HoldoutCase[];
  const rows = Array.isArray(parsed) ? parsed : parsed.cases;
  if (!rows || rows.length !== 6) throw new Error('HOLD_OUT_CASE_COUNT');
  return rows;
}

export async function runPaidHoldout(input: { zipPath: string; outDir: string; env: PaidEnv; fetchImpl?: typeof fetch }) {
  const allowed = keyAllowed(input.env);
  if (!allowed.ok) return { sent: false as const, reason: allowed.reason };
  const cases = loadCases(input.zipPath);
  const budget = createComparisonBudget();
  const rawDir = join(input.outDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const report = await runDirectComparison({
    cases,
    budget,
    maxCalls: DIRECT_MAX_CALLS,
    systemMs: DIRECT_SYSTEM_MS,
    transport: {
      send: async (request) => {
        const sent = await sendPaidExchange({
          env: input.env,
          body: request.body,
          timeoutMs: request.timeoutMs,
          fetchImpl: input.fetchImpl,
          keyOnly: true,
        });
        const name = `${request.caseId}-${request.arm}.json`;
        if (!sent.ok) {
          writeFileSync(join(rawDir, name), JSON.stringify({ ok: false, reason: sent.reason }));
          return sent;
        }
        writeFileSync(join(rawDir, name), JSON.stringify({
          ok: true,
          content: sent.content,
          usage: sent.usage,
        }));
        return { ok: true, content: sent.content, usageUsd: sent.usageUsd };
      },
    },
  });
  const summary = {
    calls: report.calls,
    maxCalls: DIRECT_MAX_CALLS,
    retries: DIRECT_RETRIES,
    ledger: report.ledger.snapshot(),
    pairs: report.pairs,
    outcomes: report.outcomes,
  };
  writeFileSync(join(input.outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return { sent: true as const, summary };
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

if (process.argv[1] && process.argv[1].endsWith('direct-paid.ts')) {
  const zipPath = arg('--zip');
  const outDir = arg('--out');
  if (!zipPath || !outDir) {
    process.stderr.write('usage: node --experimental-strip-types experiments/trade-contract/direct-paid.ts --zip <input.zip> --out <dir>\n');
    process.exit(2);
  }
  const result = await runPaidHoldout({ zipPath, outDir, env: { XAI_API_KEY: process.env.XAI_API_KEY } });
  if (!result.sent) {
    process.stderr.write(`${result.reason}. No request was sent.\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify({ calls: result.summary.calls, ledger: result.summary.ledger, pairs: result.summary.pairs })}\n`);
}
