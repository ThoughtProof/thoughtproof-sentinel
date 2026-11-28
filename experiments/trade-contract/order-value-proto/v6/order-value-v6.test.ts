import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { HoldoutCase } from '../../direct-holdout-plan.ts';
import { BINDING_BUDGET_MS } from '../../direct-historical.ts';
import { rivetAnswer } from './answers.ts';
import { runComparisonV6, type AuthorizedFacts, type SentRequest } from './comparison.ts';
import { RIVET, documentsFor, orderFor, orderSentence, standardPacket } from './packet.ts';
import { runPublicV6 } from './public.ts';

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

function stubNetwork(): void {
  globalThis.fetch = () => { throw new Error('network disabled'); };
  expect(process.env.XAI_API_KEY).toBeFalsy();
}

function clock() {
  let time = 0;
  return { now: () => time, advance(ms: number) { time += ms; } };
}

function commitFacts(quantity: string, price: string, sku = RIVET, allowlist = [RIVET]): { facts: AuthorizedFacts; content: string } {
  const mandate = standardPacket();
  const documents = documentsFor(mandate, quantity, price);
  const order = orderFor(quantity, price);
  const qty = Number(quantity);
  const unit = Number(price);
  return {
    content: JSON.stringify(rivetAnswer(documents, quantity, price)),
    facts: {
      documents, mandate, order,
      world: { sku_allowlist: allowlist, max_unit_eur: 50, max_qty: 100, max_total_eur: 5000 },
      action: { kind: 'COMMIT', sku, qty, unit_eur: unit, steps_done: [], evidence: [] },
    },
  };
}

function transport(time: ReturnType<typeof clock>, delays: Record<string, number>, contents: Record<string, string>) {
  const sent: SentRequest[] = [];
  return {
    sent,
    async send(request: SentRequest) {
      sent.push(request);
      time.advance(delays[request.arm] ?? 0);
      return { content: contents[request.arm] };
    },
  };
}

function userDocuments(body: { messages: { content: string }[] }): { id: string; role: string; text: string }[] {
  return JSON.parse(body.messages[1].content) as { id: string; role: string; text: string }[];
}

function historicalPayload(body: { messages: { content: string }[] }): {
  documents: { id: string; role: string; text: string }[];
  structured_action: { kind: string; sku: string; qty: number; unit_eur: number };
  structured_world: { sku_allowlist: string[] };
} {
  const content = body.messages[1].content;
  return JSON.parse(content.slice(content.indexOf('\n') + 1));
}

describe('order-value v6 comparison path', () => {
  it('runs an admissible COMMIT through both arms and checks the sent bodies', async () => {
    stubNetwork();
    const time = clock();
    const prepared = commitFacts('20', '40.00');
    const mock = transport(time, { sentinel_primary: 1_000, historical: 1_000 }, {
      sentinel_primary: prepared.content,
      historical: '{"execute":true,"verdict":"ALLOW"}',
    });
    const report = await runComparisonV6({
      facts: prepared.facts, clock: time, transport: mock,
    });
    const sentinelBody = mock.sent.find(item => item.arm === 'sentinel_primary')!.body as { messages: { content: string }[] };
    const historicalBody = mock.sent.find(item => item.arm === 'historical')!.body as { messages: { content: string }[] };
    const sentinelDocs = userDocuments(sentinelBody);
    const historical = historicalPayload(historicalBody);
    expect(sentinelDocs).toEqual(prepared.facts.documents.map(document => ({ id: document.id, role: document.role, text: document.text })));
    expect(historical.documents).toEqual(sentinelDocs);
    expect(historical.structured_action).toMatchObject({ kind: 'COMMIT', sku: RIVET, qty: 20, unit_eur: 40 });
    expect(historical.structured_world.sku_allowlist).toEqual([RIVET]);
    expect(report.sentinel).toMatchObject({ publicVerdict: 'ALLOW', numeric: 'fulfilled', durationMs: 1_000, executed: true, criticCalls: 0 });
    expect(report.historical).toMatchObject({ publicVerdict: 'ALLOW', durationMs: 1_000, executed: true, criticCalls: 1 });
  });

  it('does not call the historical critic when the gateway blocks', async () => {
    stubNetwork();
    const time = clock();
    const prepared = commitFacts('20', '40.00', 'SYNTH-OTHER', [RIVET]);
    const mock = transport(time, { sentinel_primary: 1_000, historical: 1_000 }, {
      sentinel_primary: prepared.content,
      historical: '{"execute":true,"verdict":"ALLOW"}',
    });
    const report = await runComparisonV6({
      facts: prepared.facts, clock: time, transport: mock,
    });
    expect(mock.sent.map(item => item.arm)).toEqual(['sentinel_primary']);
    expect(report.historical).toMatchObject({ publicVerdict: 'BLOCK', executed: false, criticCalls: 0 });
  });
});

describe('order-value v6 timing', () => {
  async function both(sentinelMs: number, historicalMs: number) {
    const time = clock();
    const prepared = commitFacts('20', '40.00');
    const mock = transport(time, { sentinel_primary: sentinelMs, historical: historicalMs }, {
      sentinel_primary: prepared.content,
      historical: '{"execute":true,"verdict":"ALLOW"}',
    });
    const report = await runComparisonV6({
      facts: prepared.facts, clock: time, transport: mock,
    });
    return report;
  }

  it('executes only the arm that finishes within its own 45 seconds', async () => {
    stubNetwork();
    const sentinelOnly = await both(1_000, 45_001);
    expect(sentinelOnly.sentinel).toMatchObject({ publicVerdict: 'ALLOW', durationMs: 1_000, executed: true, criticCalls: 0 });
    expect(sentinelOnly.historical).toMatchObject({ publicVerdict: 'ALLOW', durationMs: 45_001, executed: false, criticCalls: 1 });

    const criticOnly = await both(45_001, 1_000);
    expect(criticOnly.sentinel).toMatchObject({ publicVerdict: 'ALLOW', durationMs: 45_001, executed: false });
    expect(criticOnly.historical).toMatchObject({ publicVerdict: 'ALLOW', durationMs: 1_000, executed: true, criticCalls: 1 });
  });

  it('treats 45000 ms as inside the existing rule and 45001 ms as outside', async () => {
    stubNetwork();
    expect(BINDING_BUDGET_MS).toBe(45_000);
    const inside = await both(45_000, 45_000);
    expect(inside.sentinel.executed).toBe(true);
    expect(inside.historical.executed).toBe(true);
    expect(inside.sentinel.durationMs).toBe(45_000);
    expect(inside.historical.durationMs).toBe(45_000);
    const outside = await both(45_001, 45_001);
    expect(outside.sentinel.executed).toBe(false);
    expect(outside.historical.executed).toBe(false);
    expect(outside.sentinel.durationMs).toBe(45_001);
    expect(outside.historical.durationMs).toBe(45_001);
  });
});

describe('order-value v6 limit price marker', () => {
  function run(quantity: string, price: string, quote?: string, text?: string) {
    stubNetwork();
    const mandate = standardPacket();
    const documents = documentsFor(mandate, quantity, price);
    if (text) documents.find(document => document.role === 'proposal')!.text = `${text}\n`;
    const order = orderFor(quantity, price);
    if (quote) order.limitPrice = { value: price, quote };
    return runPublicV6({
      row: { caseId: 'pin', documents, world: {}, action: { kind: 'COMMIT' } } as HoldoutCase,
      content: JSON.stringify(rivetAnswer(documents, quantity, price)),
      mandate, order,
    });
  }

  it('gives the full order sentence the same decision as the precise limit-price quote', async () => {
    const precise = await run('20', '40.00');
    const full = await run('20', '40.00', orderSentence('20', '40.00'));
    expect(precise.composition?.proofs.find(proof => proof.clauseId === 'value-cap')).toMatchObject({ status: 'fulfilled', operand: '800' });
    expect(full.composition?.proofs.find(proof => proof.clauseId === 'value-cap')).toMatchObject({ status: 'fulfilled', operand: '800' });
    expect(full.composition?.publicVerdict).toBe(precise.composition?.publicVerdict);
    expect(full.executor).toMatchObject({ systemVerdict: 'ALLOW', executed: true });
    expect(precise.executor).toMatchObject({ systemVerdict: 'ALLOW', executed: true });
  });

  it('keeps identical quantity and price numbers assigned by the limit-price mark', async () => {
    const hosted = await run('40', '40.00', orderSentence('40', '40.00'));
    expect(hosted.composition?.proofs.find(proof => proof.clauseId === 'value-cap')).toMatchObject({
      status: 'contradicted', operand: '1600', reason: 'order_value_outside_cap',
    });
    expect(hosted.composition?.publicVerdict).toBe('BLOCK');
    expect(hosted.executor).toMatchObject({ systemVerdict: 'BLOCK', executed: false });
  });

  it('ignores an additional market price and refuses a contradiction or two limit prices', async () => {
    const sentence = `${orderSentence('20', '40.00')} Market price EUR 55.00.`;
    const market = await run('20', '40.00', sentence, sentence);
    expect(market.composition?.proofs.find(proof => proof.clauseId === 'value-cap')).toMatchObject({ status: 'fulfilled', operand: '800' });
    expect(market.executor).toMatchObject({ systemVerdict: 'ALLOW', executed: true });

    const contradicted = await run('20', '20.00', 'limit price EUR 30.00', orderSentence('20', '30.00'));
    expect(contradicted.composition?.proofs.find(proof => proof.clauseId === 'value-cap')).toMatchObject({
      status: 'not_verifiable', reason: 'price_contradiction',
    });
    expect(contradicted.executor?.executed).toBe(false);

    const unclear = 'Limit buy for 20 SYNTH-RIVET at limit price EUR 40.00 per share and limit price EUR 30.00 per share.';
    const ambiguous = await run('20', '40.00', unclear, unclear);
    expect(ambiguous.composition?.proofs.find(proof => proof.clauseId === 'value-cap')?.reason).toBe('price_unclear');
    expect(ambiguous.composition?.publicVerdict).not.toBe('ALLOW');
    expect(ambiguous.executor?.executed).toBe(false);
  });
});

describe('frozen reference hashes', () => {
  it('keeps the v4 and v5 freeze hashes', () => {
    const v4 = readFileSync(new URL('../v4/v4-freeze-manifest.json', import.meta.url));
    const v5 = readFileSync(new URL('../v5/v5-freeze-manifest.json', import.meta.url));
    expect(createHash('sha256').update(v4).digest('hex')).toBe('9b7094e9dca05c4ccd7503990f13e4133b54c83bced8c480cd128e30413eb0ff');
    expect(createHash('sha256').update(v5).digest('hex')).toBe('4a8d8fe9bf0a2d5353c5866dc3c2ddb00187b71277329530f77bec16edc4b27a');
  });
});
