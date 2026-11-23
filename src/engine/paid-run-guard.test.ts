import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  PAID_RUN_LIMITS,
  fitFrozenCaseRun,
  installPaidRunFetchGuard,
  maxPricePerCall,
  runCappedProviderLoop,
} from '../../scripts/cb4a-paid-validation-runner.mjs';

function usdResponse(usd: number): Response {
  return new Response('{}', { status: 200, headers: { 'x-provider-usd': String(usd) } });
}

function chatBody(model: string, content = 'hi', extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content }],
    ...extra,
  });
}

describe('paid-run token caps and alias ceilings', () => {
  it('writes the output ceilings onto the request body', async () => {
    let seen: { max_completion_tokens?: number; max_tokens?: number } | null = null;
    const { fetch: guarded } = installPaidRunFetchGuard(async (_url: string, init?: RequestInit) => {
      seen = JSON.parse(String(init?.body));
      return usdResponse(0);
    }, { ...PAID_RUN_LIMITS, maxUsd: 100, maxAttemptsPerDraw: 10 });
    await guarded('https://provider.test/v1/chat/completions', {
      method: 'POST',
      body: chatBody('serv-nano', 'hi', { max_completion_tokens: 8000, max_tokens: 8000 }),
    });
    expect(seen?.max_completion_tokens).toBe(4096);
    expect(seen?.max_tokens).toBe(4096);
  });

  it('refuses to send when the prompt estimate exceeds the input ceiling', async () => {
    let inner = 0;
    const { fetch: guarded } = installPaidRunFetchGuard(async () => {
      inner += 1;
      return usdResponse(0);
    });
    const tooLong = 'a'.repeat(PAID_RUN_LIMITS.tokenCeiling.inputTokens * 4 + 8);
    await expect(guarded('https://provider.test/v1/chat/completions', {
      method: 'POST',
      body: chatBody('serv-nano', tooLong),
    })).rejects.toThrow(/input/);
    expect(inner).toBe(0);
  });

  it('prices serv-swift from the Haiku 4.5 catalog row and serv-nano at the Astra ceiling', () => {
    expect(maxPricePerCall('serv-swift')).toBeCloseTo((8192 * 1.25 + 4096 * 6.5) / 1_000_000);
    expect(maxPricePerCall('serv-nano')).toBeCloseTo((8192 * 12 + 4096 * 60) / 1_000_000);
    expect(maxPricePerCall('serv-nano')).toBeGreaterThan(maxPricePerCall('serv-swift'));
  });

  it('fits only a handful of nano calls under $1.44 at the unproven ceiling', () => {
    expect(fitFrozenCaseRun({ cases: 50, draws: 1, nanoSendsPerDraw: 1, swiftSendsPerDraw: 0 }).fits).toBe(false);
    expect(fitFrozenCaseRun({ cases: 50, draws: 3, nanoSendsPerDraw: 1, swiftSendsPerDraw: 1 }).fits).toBe(false);
    expect(fitFrozenCaseRun({ cases: 4, draws: 1, nanoSendsPerDraw: 1, swiftSendsPerDraw: 0 }).fits).toBe(true);
    expect(fitFrozenCaseRun({ cases: 5, draws: 1, nanoSendsPerDraw: 1, swiftSendsPerDraw: 0 }).fits).toBe(false);
    expect(fitFrozenCaseRun({ cases: 3, draws: 1, nanoSendsPerDraw: 1, swiftSendsPerDraw: 1 }).fits).toBe(true);
    const oneRetryAndSwift = fitFrozenCaseRun({
      cases: 1, draws: 1, nanoSendsPerDraw: 2, swiftSendsPerDraw: 1,
    });
    expect(oneRetryAndSwift.fits).toBe(true);
    expect(oneRetryAndSwift.attempts).toBe(3);
  });

  it('counts a timeout after dispatch and keeps the nano ceiling booked', async () => {
    let inner = 0;
    const { fetch: guarded, guard } = installPaidRunFetchGuard(async () => {
      inner += 1;
      throw new Error('timeout');
    });
    await expect(guarded('https://provider.test/v1/chat/completions', {
      method: 'POST',
      body: chatBody('serv-nano'),
    })).rejects.toThrow(/timeout/);
    expect(inner).toBe(1);
    expect(guard.snapshot().attempts).toBe(1);
    expect(guard.snapshot().booked).toBeCloseTo(maxPricePerCall('serv-nano'));
  });

  it('reserves a nano retry and a swift fallback at their own ceilings', async () => {
    let inner = 0;
    const limits = { ...PAID_RUN_LIMITS, maxUsd: 100, maxAttemptsPerDraw: 10 };
    const { fetch: guarded, guard } = installPaidRunFetchGuard(async () => {
      inner += 1;
      return usdResponse(0);
    }, limits);
    await guarded('https://provider.test/v1', { method: 'POST', body: chatBody('serv-nano', 'retry-1') });
    await guarded('https://provider.test/v1', { method: 'POST', body: chatBody('serv-nano', 'retry-2') });
    await guarded('https://provider.test/v1', { method: 'POST', body: chatBody('serv-swift', 'fallback') });
    expect(inner).toBe(3);
    expect(guard.snapshot().attempts).toBe(3);
    expect(guard.snapshot().booked).toBeCloseTo(0);
  });

  it('allows the 180th attempt and refuses the 181st before dispatch', async () => {
    let inner = 0;
    const result = await runCappedProviderLoop({
      draws: [{ id: 'only', tries: 181 }],
      limits: { ...PAID_RUN_LIMITS, maxAttemptsPerDraw: 1000, maxUsd: 10_000 },
      send: async () => {
        inner += 1;
        return { usd: 0 };
      },
    });
    expect(result.stopped).toBe('attempts');
    expect(inner).toBe(180);
    expect(result.sends).toBe(180);
  });

  it('does not let concurrent sends overshoot one nano ceiling of budget', async () => {
    let inner = 0;
    const limits = {
      ...PAID_RUN_LIMITS,
      maxUsd: maxPricePerCall('serv-nano') + 0.01,
      maxAttemptsPerDraw: 10,
    };
    const { fetch: guarded } = installPaidRunFetchGuard(async () => {
      inner += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return usdResponse(0);
    }, limits);
    const results = await Promise.allSettled([
      guarded('https://provider.test/a', { method: 'POST', body: chatBody('serv-nano', 'a') }),
      guarded('https://provider.test/b', { method: 'POST', body: chatBody('serv-nano', 'b') }),
    ]);
    expect(inner).toBe(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('caps attempts per draw so parse retries cannot reach 7 sends', async () => {
    let inner = 0;
    const result = await runCappedProviderLoop({
      draws: [{ id: 'draw', tries: 7 }],
      limits: { ...PAID_RUN_LIMITS, maxAttempts: 1000, maxUsd: 10_000 },
      send: async () => {
        inner += 1;
        return { usd: 0 };
      },
    });
    expect(result.stopped).toBe('draw');
    expect(inner).toBe(PAID_RUN_LIMITS.maxAttemptsPerDraw);
    expect(inner).toBeLessThan(7);
  });

  it('the CLI exits before any provider send', () => {
    const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts/cb4a-paid-validation-runner.mjs')], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/No provider send/);
  });
});

describe('step-quality jq filter', () => {
  it('drops cascade_error rows before dividing step shares', () => {
    const doc = readFileSync(join(process.cwd(), 'docs/trade-execution-step-quality.md'), 'utf8');
    const program = doc.match(/jq -s '\n([\s\S]*?)\n' drain\.jsonl/)?.[1];
    expect(program).toBeTruthy();
    expect(program).toContain('.cascade_error != true');
    expect(program).toContain('.steps > 0');
    const fixture = [
      JSON.stringify({
        event: 'sentinel.trade_execution.step_quality',
        step_model: 'serv-nano',
        primary_model: 'serv-nano',
        steps: 3,
        templated_reasoning_steps: 3,
        null_or_absent_quotes: 0,
        primary_block: true,
        malformed_step_fallback: false,
        cascade_error: false,
      }),
      JSON.stringify({
        event: 'sentinel.trade_execution.step_quality',
        cascade_error: true,
        step_model: null,
        primary_model: 'serv-nano',
        steps: 0,
        templated_reasoning_steps: 0,
        null_or_absent_quotes: 0,
        primary_block: false,
        malformed_step_fallback: false,
      }),
    ].join('\n');
    const result = spawnSync('jq', ['-s', program!], { input: fixture, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.steps).toEqual([{
      model: 'serv-nano',
      n: 1,
      templated_reasoning_share: 1,
      null_quote_share: 0,
    }]);
    expect(parsed.primary).toHaveLength(1);
    expect(parsed.primary[0].primary_block_share).toBe(1);
    const errorsOnly = spawnSync('jq', ['-s', program!], {
      input: fixture.split('\n')[1] + '\n',
      encoding: 'utf8',
    });
    expect(errorsOnly.status).toBe(0);
    expect(JSON.parse(errorsOnly.stdout)).toEqual({ steps: [], primary: [] });
  });
});
