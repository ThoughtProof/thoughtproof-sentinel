import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { HoldoutCase } from '../../direct-holdout-plan.ts';
import { rivetAnswer } from './answers.ts';
import { runComparisonPreflight, type Clock } from './comparison.ts';
import {
  QTY_QUOTE, RIVET_DESK, RIVET_TICKET,
  documentsFor, orderFor, orderSentence, standardPacket,
} from './packet.ts';
import { runPublicV5 } from './public.ts';

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

function stubNetwork(): void {
  globalThis.fetch = () => { throw new Error('network disabled'); };
  expect(process.env.XAI_API_KEY).toBeFalsy();
}

function holdout(documents: HoldoutCase['documents']): HoldoutCase {
  return { caseId: 'rivet', documents, world: {}, action: { kind: 'OBSERVE' } };
}

function clock(): Clock & { advance(ms: number): void } {
  let time = 0;
  return { now: () => time, advance(ms) { time += ms; } };
}

describe('order-value v5 price binding', () => {
  it('does not release when the ticket price contradicts the structured price', async () => {
    stubNetwork();
    const mandate = standardPacket();
    const documents = documentsFor(mandate, '20', '30.00');
    const order = orderFor('20', '20.00');
    order.limitPrice = { value: '20.00', quote: 'at EUR 30.00 per share' };
    const hosted = await runPublicV5({
      row: holdout(documents), content: JSON.stringify(rivetAnswer(documents, '20', '30.00')), mandate, order,
    });
    expect(hosted.composition?.proofs.find(proof => proof.clauseId === 'value-cap')).toMatchObject({
      status: 'not_verifiable', reason: 'price_contradiction', operand: null,
    });
    expect(hosted.composition?.numericAfter).toBe('not_verifiable');
    expect(hosted.composition?.publicVerdict).not.toBe('ALLOW');
    expect(hosted.executor?.executed).toBe(false);
  });

  it('blocks an exceeded cap when the price is consistent', async () => {
    stubNetwork();
    const mandate = standardPacket();
    const documents = documentsFor(mandate, '40', '40.00');
    const hosted = await runPublicV5({
      row: holdout(documents), content: JSON.stringify(rivetAnswer(documents, '40', '40.00')),
      mandate, order: orderFor('40', '40.00'),
    });
    expect(hosted.composition?.proofs.find(proof => proof.clauseId === 'value-cap')).toMatchObject({
      status: 'contradicted', reason: 'order_value_outside_cap', operand: '1600',
    });
    expect(hosted.composition?.numericAfter).toBe('contradicted');
    expect(hosted.composition?.publicVerdict).toBe('BLOCK');
    expect(hosted.executor).toMatchObject({ systemVerdict: 'BLOCK', executed: false });
  });
});

describe('order-value v5 grounding document', () => {
  it('releases only the row whose evidence document is the checked order', async () => {
    stubNetwork();
    const mandate = standardPacket();
    const documents = documentsFor(mandate, '20', '40.00');
    const sentence = orderSentence('20', '40.00');
    documents.push({ id: 'copy-desk', role: 'source', text: `${sentence}\n` });
    const answer = rivetAnswer(documents, '20', '40.00');
    answer.grounding = [
      { objectionId: 'qty-cap', clauseDocumentId: RIVET_DESK, clauseQuote: QTY_QUOTE, evidenceDocumentId: RIVET_TICKET, evidenceQuote: sentence, reading: 'met' },
      { objectionId: 'qty-cap-copy', clauseDocumentId: RIVET_DESK, clauseQuote: QTY_QUOTE, evidenceDocumentId: 'copy-desk', evidenceQuote: sentence, reading: 'met' },
    ];
    const hosted = await runPublicV5({
      row: holdout(documents), content: JSON.stringify(answer), mandate, order: orderFor('20', '40.00'),
    });
    expect(hosted.composition?.grounding[0]).toMatchObject({ blocks: false, reason: 'quantity_span_proven' });
    expect(hosted.composition?.grounding[1]).toMatchObject({ blocks: true, reason: 'no_shared_word' });
    expect(hosted.composition?.publicVerdict).toBe('UNCERTAIN');
    expect(hosted.executor).toMatchObject({ systemVerdict: 'UNCERTAIN', executed: false });
  });
});

describe('order-value v5 reference unit', () => {
  it('rejects a location match when absolute and per_share disagree', async () => {
    stubNetwork();
    const mandate = standardPacket();
    const documents = documentsFor(mandate, '20', '40.00');
    const mismatched = await runPublicV5({
      row: holdout(documents),
      content: JSON.stringify(rivetAnswer(documents, '20', '40.00', {
        extraLimits: [{
          id: 'lim-qty', measure: 'share_count', unit: 'shares', referenceId: 'per_share',
          operator: '<=', value: '80', documentId: RIVET_DESK, bindingQuote: QTY_QUOTE, valueQuote: '80',
        }],
      })),
      mandate, order: orderFor('20', '40.00'),
    });
    expect(mismatched.composition?.replacedLimitIds).not.toContain('lim-qty');
    expect(mismatched.composition?.numericAfter).toBe('not_verifiable');
    expect(mismatched.executor?.executed).toBe(false);

    const matched = await runPublicV5({
      row: holdout(documents),
      content: JSON.stringify(rivetAnswer(documents, '20', '40.00', {
        extraLimits: [{
          id: 'lim-qty', measure: 'share_count', unit: 'shares', referenceId: 'absolute',
          operator: '<=', value: '80', documentId: RIVET_DESK, bindingQuote: QTY_QUOTE, valueQuote: '80',
        }],
      })),
      mandate, order: orderFor('20', '40.00'),
    });
    expect(matched.composition?.replacedLimitIds).toEqual(['lim-qty']);
    expect(matched.composition?.publicVerdict).toBe('ALLOW');
    expect(matched.executor).toMatchObject({ systemVerdict: 'ALLOW', executed: true });
  });
});

describe('order-value v5 comparison preflight', () => {
  function facts() {
    const mandate = standardPacket();
    const documents = documentsFor(mandate, '20', '40.00');
    const order = orderFor('20', '40.00');
    const content = JSON.stringify(rivetAnswer(documents, '20', '40.00'));
    return {
      content,
      facts: { documents, mandate, order, world: {}, action: { kind: 'OBSERVE' } },
    };
  }

  it('feeds both systems the packet fixed before the answer, and executes an on-time ALLOW', async () => {
    stubNetwork();
    const time = clock();
    const prepared = facts();
    const result = await runComparisonPreflight({
      facts: prepared.facts,
      clock: time,
      transport: asyncRequest(async request => {
        expect(request.arm === 'sentinel_primary' || request.arm === 'historical').toBe(true);
        if (request.arm === 'sentinel_primary') time.advance(1_000);
        return { content: prepared.content };
      }),
    });
    expect(result.sentinelFacts.mandate).toBe(result.historicalFacts.mandate);
    expect(result.sentinelFacts.order).toBe(result.historicalFacts.order);
    expect(result.sentinelFacts.documents).toBe(result.historicalFacts.documents);
    expect(result.budgetMs).toBe(45_000);
    expect(result.durationMs).toBeGreaterThanOrEqual(1_000);
    expect(result.durationMs).toBeLessThanOrEqual(45_000);
    expect(result.publicVerdict).toBe('ALLOW');
    expect(result.timing).toBe('on_time');
    expect(result.executed).toBe(true);
  });

  it('records a late ALLOW as not executed, including host time past the deadline', async () => {
    stubNetwork();
    const time = clock();
    const prepared = facts();
    const late = await runComparisonPreflight({
      facts: prepared.facts,
      clock: time,
      transport: asyncRequest(async request => {
        if (request.arm === 'sentinel_primary') time.advance(45_001);
        return { content: prepared.content };
      }),
    });
    expect(late.publicVerdict).toBe('ALLOW');
    expect(late.durationMs).toBeGreaterThan(45_000);
    expect(late.timing).toBe('late');
    expect(late.executed).toBe(false);

    const boundary = clock();
    const pushed = await runComparisonPreflight({
      facts: prepared.facts,
      clock: boundary,
      transport: asyncRequest(async request => {
        if (request.arm === 'sentinel_primary') boundary.advance(45_000);
        return { content: prepared.content };
      }),
      beforeHost: () => boundary.advance(1),
    });
    expect(pushed.publicVerdict).toBe('ALLOW');
    expect(pushed.durationMs).toBe(45_001);
    expect(pushed.timing).toBe('late');
    expect(pushed.executed).toBe(false);
  });
});

function asyncRequest(
  send: (request: { arm: 'sentinel_primary' | 'historical'; body: unknown }) => Promise<{ content: string }>,
) {
  return { send };
}

describe('order-value v4 freeze still valid', () => {
  it('keeps the v4 freeze hash', () => {
    const bytes = readFileSync(new URL('../v4/v4-freeze-manifest.json', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('9b7094e9dca05c4ccd7503990f13e4133b54c83bced8c480cd128e30413eb0ff');
  });
});
