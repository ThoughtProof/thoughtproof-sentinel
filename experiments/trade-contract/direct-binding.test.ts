import { describe, expect, it } from 'vitest';
import { strictBinding } from './direct-binding.ts';
import { DUMMY_GATEWAY_PROBE } from './direct-preflight-dummy.ts';
import { sentinelStage } from './direct-sentinel-stage.ts';
import { dummyDocuments } from './direct-preflight-dummy.ts';

const world = DUMMY_GATEWAY_PROBE.world;
const action = DUMMY_GATEWAY_PROBE.action;

function row(execute: boolean, verdict: string, durationMs = 1_000) {
  return strictBinding({ world, action, durationMs, raw: { execute, verdict } });
}

describe('strict historical binding on the dummy case', () => {
  it('rejects contradictory raw fields and executes only a timely typed ALLOW', () => {
    for (const verdict of ['BLOCK', 'REVIEW', 'UNCERTAIN']) {
      const result = row(true, verdict);
      expect(result.gatewayPassed).toBe(true);
      expect(result.criticReached).toBe(true);
      expect(result.protocolError).toBe('protocol_error');
      expect(result.executed).toBe(false);
      expect(result.september).toEqual({ label: 'september_rule', verdict: 'ALLOW', execute: true });
    }
    const falseAllow = row(false, 'ALLOW');
    expect(falseAllow.protocolError).toBe('protocol_error');
    expect(falseAllow.executed).toBe(false);
    expect(falseAllow.september).toEqual({ label: 'september_rule', verdict: 'ALLOW', execute: false });
    const timely = row(true, 'ALLOW', 1_000);
    expect(timely.protocolError).toBeNull();
    expect(timely.executed).toBe(true);
    expect(timely.september).toEqual({ label: 'september_rule', verdict: 'ALLOW', execute: true });
    const late = row(true, 'ALLOW', 45_001);
    expect(late.protocolError).toBeNull();
    expect(late.executed).toBe(false);
    expect(late.september?.execute).toBe(true);
    const blocked = strictBinding({
      world, action: { ...action, qty: 9 }, durationMs: 1_000, raw: { execute: true, verdict: 'ALLOW' },
    });
    expect(blocked.gatewayPassed).toBe(false);
    expect(blocked.criticReached).toBe(false);
    expect(blocked.protocolError).toBeNull();
    expect(blocked.executed).toBe(false);
    expect(blocked.september).toBeNull();
  });

  it('logs a protocol error when the critic fields are missing or not typed', () => {
    const missing = strictBinding({ world, action, durationMs: 1_000, raw: null });
    expect(missing.protocolError).toBe('protocol_error');
    expect(missing.executed).toBe(false);
    const invalid = strictBinding({ world, action, durationMs: 1_000, raw: { execute: 'true', verdict: 'ALLOW' } });
    expect(invalid.protocolError).toBe('protocol_error');
    expect(invalid.executed).toBe(false);
  });
});

describe('sentinel secondary stage', () => {
  const documents = dummyDocuments();

  it('publishes only BLOCK or UNCERTAIN from the secondary and records the stage', () => {
    const allow = sentinelStage({
      documents,
      primary: { ok: false, reason: 'empty' },
      secondary: { ok: true, content: '{"verdict":"ALLOW"}' },
    });
    expect(allow.secondary_called).toBe(true);
    expect(allow.public_verdict_stage).toBe('secondary');
    expect(allow.publicVerdict).toBe('UNCERTAIN');
    const block = sentinelStage({
      documents,
      primary: { ok: false, reason: 'empty' },
      secondary: { ok: true, content: '{"verdict":"BLOCK"}' },
    });
    expect(block.secondary_called).toBe(true);
    expect(block.publicVerdict).toBe('BLOCK');
    const skipped = sentinelStage({
      documents,
      primary: { ok: false, reason: 'empty' },
      secondary: null,
    });
    expect(skipped.secondary_called).toBe(false);
    expect(skipped.public_verdict_stage).toBe('primary');
    expect(skipped.publicVerdict).not.toBe('ALLOW');
  });
});
