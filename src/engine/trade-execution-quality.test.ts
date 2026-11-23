import { describe, expect, it } from 'vitest';
import {
  TRADE_EXECUTION_QUALITY_ALERT,
  TRADE_EXECUTION_QUALITY_EVENT,
  TRADE_EXECUTION_QUALITY_MIN_SAMPLES,
  countsAsAllow,
  recordTradeExecutionStepQuality,
  resetTradeExecutionQualityForTests,
  tradeExecutionQualityShares,
} from './trade-execution-quality.js';

function sample(over: Partial<Parameters<typeof recordTradeExecutionStepQuality>[0]> = {}) {
  return {
    verificationId: 'sent_test',
    surfacedModel: 'serv-nano',
    primaryModel: 'serv-nano',
    cascadeReason: 'primary_block',
    malformedStepFallback: false,
    steps: [
      { templatedReasoning: true, nullQuote: true },
      { templatedReasoning: true, nullQuote: true },
      { templatedReasoning: true, nullQuote: true },
    ],
    ...over,
  };
}

describe('trade_execution step quality counters', () => {
  it('records templated reasoning, null quotes, and primary_block per model', () => {
    resetTradeExecutionQualityForTests();
    const lines: string[] = [];
    recordTradeExecutionStepQuality(sample(), (line) => lines.push(line), () => {});
    const logged = JSON.parse(lines[0]) as {
      event: string;
      templated_reasoning_steps: number;
      null_or_absent_quotes: number;
      primary_block: boolean;
      malformed_step_fallback: boolean;
    };
    expect(logged.event).toBe(TRADE_EXECUTION_QUALITY_EVENT);
    expect(logged.templated_reasoning_steps).toBe(3);
    expect(logged.null_or_absent_quotes).toBe(3);
    expect(logged.primary_block).toBe(true);
    expect(logged.malformed_step_fallback).toBe(false);
    const shares = tradeExecutionQualityShares('serv-nano');
    expect(shares.templated_reasoning_share).toBe(1);
    expect(shares.null_quote_share).toBe(1);
    expect(shares.primary_block_share).toBe(1);
    expect(shares.malformed_fallback_share).toBe(0);
  });

  it('counts a malformed-step fallback on the primary model', () => {
    resetTradeExecutionQualityForTests();
    recordTradeExecutionStepQuality(sample({
      surfacedModel: 'serv-swift',
      cascadeReason: 'primary_error_fallback',
      malformedStepFallback: true,
      steps: [{ templatedReasoning: false, nullQuote: false }],
    }), () => {}, () => {});
    expect(tradeExecutionQualityShares('serv-nano').malformed_fallback_share).toBe(1);
    expect(tradeExecutionQualityShares('serv-nano').primary_block_share).toBe(0);
    expect(tradeExecutionQualityShares('serv-swift').malformed_fallback_share).toBe(0);
    expect(tradeExecutionQualityShares('serv-swift').null_quote_share).toBe(0);
    expect(tradeExecutionQualityShares('serv-swift').templated_reasoning_share).toBe(0);
  });

  it('warns when the primary_block share crosses the threshold', () => {
    resetTradeExecutionQualityForTests();
    const warns: string[] = [];
    for (let i = 0; i < TRADE_EXECUTION_QUALITY_MIN_SAMPLES; i++) {
      recordTradeExecutionStepQuality(sample({ verificationId: `s${i}` }), () => {}, (line) => warns.push(line));
    }
    expect(warns.length).toBeGreaterThan(0);
    const alerts = warns.map((line) => JSON.parse(line) as { event: string; metric: string; share: number });
    expect(alerts.every((a) => a.event === TRADE_EXECUTION_QUALITY_ALERT)).toBe(true);
    const primary = alerts.find((a) => a.metric === 'primary_block_share');
    expect(primary?.share).toBe(1);
    const before = warns.length;
    recordTradeExecutionStepQuality(sample(), () => {}, (line) => warns.push(line));
    expect(warns.length).toBe(before);
  });
});

describe('fail-closed allow accounting', () => {
  it('never counts UNCERTAIN, errors, or 401/429/5xx as ALLOW', () => {
    expect(countsAsAllow('ALLOW')).toBe(true);
    expect(countsAsAllow('ALLOW', 200)).toBe(true);
    expect(countsAsAllow('UNCERTAIN')).toBe(false);
    expect(countsAsAllow('BLOCK')).toBe(false);
    expect(countsAsAllow('ERROR')).toBe(false);
    expect(countsAsAllow(null)).toBe(false);
    expect(countsAsAllow('ALLOW', 401)).toBe(false);
    expect(countsAsAllow('ALLOW', 429)).toBe(false);
    expect(countsAsAllow('ALLOW', 500)).toBe(false);
    expect(countsAsAllow('ALLOW', 503)).toBe(false);
  });
});
