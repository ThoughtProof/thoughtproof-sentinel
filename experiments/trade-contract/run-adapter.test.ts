import { afterEach, describe, expect, it } from 'vitest';
import { rivetAnswer } from './order-value-proto/v6/answers.ts';
import { RIVET, documentsFor, orderFor, standardPacket } from './order-value-proto/v6/packet.ts';
import { runAdapter, type RunAdapterTransport } from './run-adapter.ts';

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

function facts() {
  const mandate = standardPacket();
  const documents = documentsFor(mandate, '20', '40.00');
  return {
    documents, mandate, order: orderFor('20', '40.00'),
    world: { sku_allowlist: [RIVET], max_unit_eur: 50, max_qty: 100, max_total_eur: 5000 },
    action: { kind: 'COMMIT', sku: RIVET, qty: 20, unit_eur: 40, steps_done: [], evidence: [] },
    allow: JSON.stringify(rivetAnswer(documents, '20', '40.00')),
  };
}

function transport(reply: RunAdapterTransport['send']): RunAdapterTransport & { arms: string[] } {
  const arms: string[] = [];
  return {
    arms,
    async send(request) {
      arms.push(request.arm);
      return reply(request);
    },
  };
}

describe('run adapter failures', () => {
  it('records a Sentinel timeout and still lets the critic decide', async () => {
    globalThis.fetch = () => { throw new Error('network disabled'); };
    const base = facts();
    const mock = transport(async request => request.arm === 'sentinel_primary'
      ? { ok: false as const, reason: 'timeout' as const }
      : { ok: true as const, content: '{"execute":true,"verdict":"ALLOW"}', usageUsd: null });
    const report = await runAdapter({ ...base, transport: mock });
    expect(mock.arms).toEqual(['sentinel_primary', 'historical']);
    expect(report.sentinel).toMatchObject({ recorded: 'timeout', publicVerdict: null, protocolError: null, executed: false, criticCalls: 0 });
    expect(report.historical).toMatchObject({ recorded: 'public_verdict', publicVerdict: 'ALLOW', executed: true, criticCalls: 1 });
    expect(report.sentinel.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.budgetClosed).toBe(false);
  });

  it('records a critic timeout and still lets Sentinel decide', async () => {
    globalThis.fetch = () => { throw new Error('network disabled'); };
    const base = facts();
    const mock = transport(async request => request.arm === 'historical'
      ? { ok: false as const, reason: 'timeout' as const }
      : { ok: true as const, content: base.allow, usageUsd: null });
    const report = await runAdapter({ ...base, transport: mock });
    expect(mock.arms).toEqual(['sentinel_primary', 'historical']);
    expect(report.historical).toMatchObject({ recorded: 'timeout', publicVerdict: null, executed: false, criticCalls: 1 });
    expect(report.sentinel).toMatchObject({ recorded: 'public_verdict', publicVerdict: 'ALLOW', executed: true, criticCalls: 0 });
  });

  it('records critic {} as protocol_error and not as ALLOW or UNCERTAIN', async () => {
    globalThis.fetch = () => { throw new Error('network disabled'); };
    const base = facts();
    const mock = transport(async request => ({
      ok: true as const,
      content: request.arm === 'historical' ? '{}' : base.allow,
      usageUsd: null,
    }));
    const report = await runAdapter({ ...base, transport: mock });
    expect(report.historical).toMatchObject({
      recorded: 'protocol_error', publicVerdict: null, protocolError: 'protocol_error', executed: false, criticCalls: 1,
    });
    expect(report.historical.publicVerdict).not.toBe('ALLOW');
    expect(report.historical.publicVerdict).not.toBe('UNCERTAIN');
    expect(report.sentinel).toMatchObject({ recorded: 'public_verdict', publicVerdict: 'ALLOW', executed: true });
  });

  it('records Sentinel {} as protocol_error and still lets the critic decide', async () => {
    globalThis.fetch = () => { throw new Error('network disabled'); };
    const base = facts();
    const mock = transport(async request => ({
      ok: true as const,
      content: request.arm === 'sentinel_primary' ? '{}' : '{"execute":true,"verdict":"ALLOW"}',
      usageUsd: null,
    }));
    const report = await runAdapter({ ...base, transport: mock });
    expect(report.sentinel).toMatchObject({
      recorded: 'protocol_error', publicVerdict: null, protocolError: 'protocol_error', executed: false, criticCalls: 0,
    });
    expect(report.sentinel.publicVerdict).not.toBe('ALLOW');
    expect(report.sentinel.publicVerdict).not.toBe('UNCERTAIN');
    expect(report.historical).toMatchObject({ recorded: 'public_verdict', publicVerdict: 'ALLOW', executed: true, criticCalls: 1 });
    expect(report.budgetClosed).toBe(false);
  });
});
