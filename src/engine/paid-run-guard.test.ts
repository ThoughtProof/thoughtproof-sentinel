import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  PAID_RUN_LIMITS,
  installPaidRunFetchGuard,
  maxPricePerCall,
  runCappedProviderLoop,
} from '../../scripts/cb4a-paid-validation-runner.mjs';

function usdResponse(usd: number, status = 200): Response {
  return new Response('{}', { status, headers: { 'x-provider-usd': String(usd) } });
}

describe('paid-run hard caps', () => {
  it('refuses the second $0.80 reply before dispatch', async () => {
    let inner = 0;
    const { fetch: guarded } = installPaidRunFetchGuard(async () => {
      inner += 1;
      return usdResponse(0.8);
    });
    await guarded('https://provider.test/chat/completions', { method: 'POST' });
    await expect(guarded('https://provider.test/chat/completions', { method: 'POST' })).rejects.toThrow(/cost/);
    expect(inner).toBe(1);
    expect(maxPricePerCall()).toBeGreaterThan(0.64);
  });

  it('counts a timeout after dispatch and keeps the max-price reservation', async () => {
    let inner = 0;
    const { fetch: guarded, guard } = installPaidRunFetchGuard(async () => {
      inner += 1;
      throw new Error('timeout');
    });
    await expect(guarded('https://provider.test/chat/completions', { method: 'POST' })).rejects.toThrow(/timeout/);
    expect(inner).toBe(1);
    expect(guard.snapshot().attempts).toBe(1);
    expect(guard.snapshot().booked).toBeCloseTo(maxPricePerCall());
    await expect(guarded('https://provider.test/chat/completions', { method: 'POST' })).rejects.toThrow(/cost/);
    expect(inner).toBe(1);
  });

  it('reserves once per retry and once for the swift fallback', async () => {
    let inner = 0;
    const limits = {
      ...PAID_RUN_LIMITS,
      maxUsd: 100,
      maxAttemptsPerDraw: 10,
    };
    const { fetch: guarded, guard } = installPaidRunFetchGuard(async () => {
      inner += 1;
      return usdResponse(0);
    }, limits);
    await guarded('https://provider.test/v1', { method: 'POST', body: JSON.stringify({ model: 'serv-nano', retry: 1 }) });
    await guarded('https://provider.test/v1', { method: 'POST', body: JSON.stringify({ model: 'serv-nano', retry: 2 }) });
    await guarded('https://provider.test/v1', { method: 'POST', body: JSON.stringify({ model: 'serv-swift', fallback: true }) });
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

  it('does not let concurrent sends overshoot the cost cap', async () => {
    let inner = 0;
    const { fetch: guarded } = installPaidRunFetchGuard(async () => {
      inner += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return usdResponse(0.8);
    });
    const results = await Promise.allSettled([
      guarded('https://provider.test/a', { method: 'POST' }),
      guarded('https://provider.test/b', { method: 'POST' }),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(inner).toBe(1);
    expect(rejected).toHaveLength(1);
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
