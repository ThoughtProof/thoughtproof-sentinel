import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  PAID_RUN_LIMITS,
  runCappedProviderLoop,
} from '../../scripts/cb4a-paid-validation-runner.mjs';

describe('paid-run hard caps', () => {
  it('stops before the 181st provider send', async () => {
    let sends = 0;
    const result = await runCappedProviderLoop({
      draws: [{ id: 'only', tries: 200 }],
      limits: { ...PAID_RUN_LIMITS, maxAttemptsPerDraw: 1000, maxUsd: 10_000 },
      send: async () => {
        sends += 1;
        return { usd: 0 };
      },
    });
    expect(result.stopped).toBe('attempts');
    expect(sends).toBe(180);
    expect(result.sends).toBe(180);
  });

  it('stops before the next send once measured or priced cost reaches $1.44', async () => {
    let sends = 0;
    const result = await runCappedProviderLoop({
      draws: [{ id: 'cost', tries: 40 }],
      limits: { ...PAID_RUN_LIMITS, maxAttempts: 1000, maxAttemptsPerDraw: 1000, pricedUsdPerCall: 0.08 },
      send: async () => {
        sends += 1;
        return {};
      },
    });
    expect(result.stopped).toBe('cost');
    expect(sends).toBe(18);
    expect(result.usd).toBeCloseTo(1.44);
  });

  it('uses a measured cost when the provider returns one', async () => {
    let sends = 0;
    const result = await runCappedProviderLoop({
      draws: [{ id: 'measured', tries: 10 }],
      limits: { ...PAID_RUN_LIMITS, maxAttempts: 1000, maxAttemptsPerDraw: 1000, pricedUsdPerCall: 0 },
      send: async () => {
        sends += 1;
        return { usd: 0.8 };
      },
    });
    expect(result.stopped).toBe('cost');
    expect(sends).toBe(2);
    expect(result.usd).toBeCloseTo(1.6);
  });

  it('caps attempts per draw so parse retries cannot reach 7 sends', async () => {
    let sends = 0;
    const result = await runCappedProviderLoop({
      draws: [{ id: 'draw', tries: 7 }],
      limits: { ...PAID_RUN_LIMITS, maxAttempts: 1000, maxUsd: 10_000 },
      send: async () => {
        sends += 1;
        return { usd: 0 };
      },
    });
    expect(result.stopped).toBe('draw');
    expect(sends).toBe(PAID_RUN_LIMITS.maxAttemptsPerDraw);
    expect(sends).toBeLessThan(7);
  });

  it('the CLI exits before any provider send', () => {
    const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts/cb4a-paid-validation-runner.mjs')], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/No provider send/);
  });
});