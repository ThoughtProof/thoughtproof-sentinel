import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { HoldoutCase } from '../../direct-holdout-plan.ts';
import { boltAnswer } from './answers.ts';
import {
  BOLT, BOLT_DESK, BOLT_TICKET, boltDocuments, boltOrder, boltPacket, orderCap,
} from './cases.ts';
import { bindAuthorizedCap } from './host.ts';
import { runPublicOrderValue } from './public.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubNetwork(): void {
  globalThis.fetch = () => {
    throw new Error('network disabled');
  };
  expect(process.env.XAI_API_KEY).toBeFalsy();
}

function row(caseId: string, documents: HoldoutCase['documents']): HoldoutCase {
  return { caseId, documents, world: {}, action: { kind: 'OBSERVE' } };
}

async function publish(quantity: string, price: string, listed: boolean) {
  stubNetwork();
  const documents = boltDocuments(quantity, price);
  const content = JSON.stringify(boltAnswer(documents, quantity, price, { includeCapLimit: listed }));
  return runPublicOrderValue({
    row: row(`bolt-${quantity}-${price}-${listed ? 'listed' : 'omitted'}`, documents),
    content,
    packet: boltPacket(),
    order: boltOrder(quantity, price),
  });
}

describe('order-value prototype v2', () => {
  it('does not let a forecast or a foreign policy with the same number bind', () => {
    const documents = boltDocuments('20', '40.00');
    documents.push({
      id: 'foreign-desk', role: 'source',
      text: 'Account SYNTH-OTHER policy. Maximum order value EUR 1000.00 inclusive.\n',
    });
    const order = boltOrder('20', '40.00');
    const decoys = bindAuthorizedCap(documents, boltPacket([
      orderCap({ purpose: 'forecast', orderRef: 'forecast-shelf', source: { documentId: BOLT_DESK, quote: 'Forecast: the shelf may reach EUR 1000.00 next quarter.' } }),
      orderCap({ purpose: 'foreign_policy', instrument: 'SYNTH-OTHER', orderRef: 'foreign-ticket', source: { documentId: 'foreign-desk', quote: 'Maximum order value EUR 1000.00 inclusive.' } }),
    ]), order);
    expect(decoys).toMatchObject({ status: 'not_verifiable', reason: 'cap_missing', record: null });
    const other = bindAuthorizedCap(documents, boltPacket(), boltOrder('20', '40.00', { instrument: 'SYNTH-OTHER', orderRef: 'foreign-ticket' }));
    expect(other).toMatchObject({ status: 'not_applicable', reason: 'cap_not_applicable' });
    const bound = bindAuthorizedCap(documents, boltPacket([
      orderCap({ purpose: 'forecast', orderRef: 'forecast-shelf', source: { documentId: BOLT_DESK, quote: 'Forecast: the shelf may reach EUR 1000.00 next quarter.' } }),
      orderCap({ purpose: 'foreign_policy', instrument: 'SYNTH-OTHER', orderRef: 'foreign-ticket', source: { documentId: 'foreign-desk', quote: 'Maximum order value EUR 1000.00 inclusive.' } }),
      orderCap(),
    ]), order);
    expect(bound.record?.purpose).toBe('order_cap');
    expect(bound.record?.orderRef).toBe(BOLT_TICKET);
    expect(bound.record?.instrument).toBe(BOLT);
  });

  it('publishes ALLOW below and exactly on the inclusive cap, listed or omitted', async () => {
    const belowOmitted = await publish('20', '40.00', false);
    const belowListed = await publish('20', '40.00', true);
    const exactOmitted = await publish('25', '40.00', false);
    const exactListed = await publish('25', '40.00', true);
    expect(belowOmitted.frozenRunnerVerdict).toBe('ALLOW');
    expect(belowOmitted.composition).toMatchObject({
      numericAfter: 'fulfilled', publicVerdict: 'ALLOW',
      replaced: { before: 'omitted', after: 'fulfilled', limitId: null },
      calculation: { result: '800', limitPrice: '40.00', cap: '1000.00' },
    });
    expect(belowListed.frozenRunnerVerdict).toBe('UNCERTAIN');
    expect(belowListed.composition).toMatchObject({
      numericBefore: 'not_verifiable', numericAfter: 'fulfilled', publicVerdict: 'ALLOW',
      replaced: { before: 'not_verifiable', after: 'fulfilled', limitId: 'lim-notional' },
    });
    expect(exactOmitted.composition?.publicVerdict).toBe('ALLOW');
    expect(exactOmitted.composition?.calculation?.result).toBe('1000');
    expect(exactListed.frozenRunnerVerdict).toBe('UNCERTAIN');
    expect(exactListed.composition?.publicVerdict).toBe('ALLOW');
    expect(exactListed.composition?.replaced.after).toBe('fulfilled');
  });

  it('blocks an exceeded cap whether the extractor listed it or omitted it', async () => {
    const omitted = await publish('40', '30.00', false);
    const listed = await publish('40', '30.00', true);
    expect(omitted.frozenRunnerVerdict).toBe('ALLOW');
    expect(omitted.composition).toMatchObject({
      numericBefore: 'fulfilled', numericAfter: 'contradicted', publicVerdict: 'BLOCK',
      replaced: { before: 'omitted', after: 'contradicted' },
      calculation: { result: '1200', formula: 'quantity * limit_price' },
    });
    expect(listed.frozenRunnerVerdict).toBe('UNCERTAIN');
    expect(listed.composition?.publicVerdict).toBe('BLOCK');
    expect(listed.composition?.replaced).toMatchObject({ before: 'not_verifiable', after: 'contradicted', limitId: 'lim-notional' });
  });

  it('does not release when the product fits but another obligation fails', async () => {
    stubNetwork();
    const documents = boltDocuments('90', '10.00');
    const overQuantity = await runPublicOrderValue({
      row: row('bolt-qty', documents),
      content: JSON.stringify(boltAnswer(documents, '90', '10.00', { includeCapLimit: false })),
      packet: boltPacket(),
      order: boltOrder('90', '10.00'),
    });
    expect(overQuantity.composition?.replaced.after).toBe('fulfilled');
    expect(overQuantity.composition?.calculation?.result).toBe('900');
    expect(overQuantity.composition?.numericAfter).toBe('contradicted');
    expect(overQuantity.composition?.publicVerdict).not.toBe('ALLOW');
    expect(overQuantity.frozenRunnerVerdict).toBe('BLOCK');

    const mandated = boltDocuments('20', '40.00');
    const contradicted = await runPublicOrderValue({
      row: row('bolt-mandate', mandated),
      content: JSON.stringify(boltAnswer(mandated, '20', '40.00', { includeCapLimit: false, mandateStatus: 'contradicted' })),
      packet: boltPacket(),
      order: boltOrder('20', '40.00'),
    });
    expect(contradicted.composition?.replaced.after).toBe('fulfilled');
    expect(contradicted.composition?.publicVerdict).toBe('BLOCK');
    expect(contradicted.composition?.blockers.some(item => item.checkId === 'mandate_compliance')).toBe(true);
  });

  it('stays UNCERTAIN when the required cap is missing or two caps match', async () => {
    stubNetwork();
    const documents = boltDocuments('20', '40.00');
    const missing = await runPublicOrderValue({
      row: row('bolt-missing', documents),
      content: JSON.stringify(boltAnswer(documents, '20', '40.00')),
      packet: boltPacket([orderCap({
        purpose: 'forecast', orderRef: 'forecast-shelf',
        source: { documentId: BOLT_DESK, quote: 'Forecast: the shelf may reach EUR 1000.00 next quarter.' },
      })]),
      order: boltOrder('20', '40.00'),
    });
    expect(missing.frozenRunnerVerdict).toBe('ALLOW');
    expect(missing.composition?.replaced.reason).toBe('cap_missing');
    expect(missing.composition?.publicVerdict).toBe('UNCERTAIN');

    const ambiguous = await runPublicOrderValue({
      row: row('bolt-two-caps', documents),
      content: JSON.stringify(boltAnswer(documents, '20', '40.00')),
      packet: boltPacket([orderCap(), orderCap({ value: '1000.00' })]),
      order: boltOrder('20', '40.00'),
    });
    expect(ambiguous.composition?.replaced.reason).toBe('cap_ambiguous');
    expect(ambiguous.composition?.publicVerdict).toBe('UNCERTAIN');
  });

  it('does not use a market price, and a grounding row still blocks a fitting product', async () => {
    stubNetwork();
    const documents = boltDocuments('40', '20.00', 'Market price: EUR 45.00 per share.');
    const answer = boltAnswer(documents, '40', '20.00') as { grounding?: unknown };
    answer.grounding = [{
      objectionId: 'n-cap',
      clauseDocumentId: BOLT_DESK,
      clauseQuote: 'Maximum quantity 80 shares.',
      evidenceDocumentId: BOLT_DESK,
      evidenceQuote: '80',
      reading: 'met',
    }];
    const hosted = await runPublicOrderValue({
      row: row('bolt-market', documents),
      content: JSON.stringify(answer),
      packet: boltPacket(),
      order: boltOrder('40', '20.00'),
    });
    expect(hosted.composition?.calculation).toMatchObject({ limitPrice: '20.00', result: '800' });
    expect(hosted.composition?.replaced.after).toBe('fulfilled');
    expect(hosted.composition?.numericAfter).toBe('fulfilled');
    expect(hosted.composition?.frozenVerdict).toBe('ALLOW');
    expect(hosted.frozenRunnerVerdict).toBe('UNCERTAIN');
    expect(hosted.composition?.publicVerdict).toBe('UNCERTAIN');
    expect(hosted.composition?.blockers.some(item => item.checkId === 'grounding')).toBe(true);
  });

  it('keeps its own manifest hash', () => {
    const manifestPath = new URL('./MANIFEST.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string; files: { path: string; sha256: string }[] };
    expect(manifest.version).toBe('order-value-proto/v2');
    expect(createHash('sha256').update(readFileSync(manifestPath)).digest('hex'))
      .toBe('a69e5d771aa3165eb4e22f72815ee819892a610d345958534a72ecf78956c557');
    for (const file of manifest.files) {
      const bytes = readFileSync(new URL(`../../../../${file.path}`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256);
    }
  });
});
