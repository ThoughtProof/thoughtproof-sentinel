import { afterEach, describe, expect, it } from 'vitest';
import type { HoldoutCase } from '../../direct-holdout-plan.ts';
import type { SafeMode } from './host.ts';
import { rejectUnsafe } from './host.ts';
import { rivetAnswer } from './answers.ts';
import {
  OTHER_DESK, OTHER_TICKET, QTY_QUOTE, RIVET_DESK, RIVET_TICKET,
  documentsFor, orderFor, orderSentence, packetWithOtherOrder, standardPacket,
} from './packet.ts';
import { composeDiagnostic, runPublicV4 } from './public.ts';

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

function stubNetwork(): void {
  globalThis.fetch = () => { throw new Error('network disabled'); };
  expect(process.env.XAI_API_KEY).toBeFalsy();
}

function row(documents: HoldoutCase['documents'], caseId: string): HoldoutCase {
  return { caseId, documents, world: {}, action: { kind: 'OBSERVE' } };
}

function ground(quote: string, reading: 'met' | 'open' | 'violated' = 'met', documentId = RIVET_TICKET) {
  return {
    objectionId: 'qty-cap', clauseDocumentId: RIVET_DESK, clauseQuote: QTY_QUOTE,
    evidenceDocumentId: documentId, evidenceQuote: quote, reading,
  };
}

async function execute(quantity: string, price: string, mandate = standardPacket(), edit?: (answer: Record<string, unknown>) => void, extra?: Parameters<typeof rivetAnswer>[3]) {
  stubNetwork();
  const documents = documentsFor(mandate, quantity, price);
  const answer = rivetAnswer(documents, quantity, price, extra);
  edit?.(answer);
  return runPublicV4({
    row: row(documents, `rivet-${quantity}-${price}`),
    content: JSON.stringify(answer),
    mandate, order: orderFor(quantity, price),
  });
}

describe('order-value v4 executable entry', () => {
  it('rejects a release that is not paired with clause enforcement', () => {
    expect(() => rejectUnsafe({ clauseBinding: false, quantityGrounding: true })).toThrow('UNSAFE_EXECUTABLE_MODE');
    type Unsafe = { clauseBinding: false; quantityGrounding: true };
    type Blocked = Unsafe extends SafeMode ? never : true;
    const blocked: Blocked = true;
    expect(blocked).toBe(true);
    expect(rejectUnsafe({ clauseBinding: true, quantityGrounding: false })).toEqual({ clauseBinding: true, quantityGrounding: false });
  });

  it('releases a sentence that states the quantity and the price together', async () => {
    const hosted = await execute('20', '40.00', standardPacket(), answer => {
      answer.grounding = [ground(orderSentence('20', '40.00'))];
    });
    expect(hosted.frozenRunnerVerdict).toBe('UNCERTAIN');
    expect(hosted.composition?.numericAfter).toBe('fulfilled');
    expect(hosted.composition?.proofs.find(proof => proof.clauseId === 'qty-cap')).toMatchObject({ status: 'fulfilled', operand: '20' });
    expect(hosted.composition?.proofs.find(proof => proof.clauseId === 'value-cap')).toMatchObject({ status: 'fulfilled', operand: '800' });
    expect(hosted.composition?.grounding[0]).toMatchObject({ blocks: false, reason: 'quantity_span_proven' });
    expect(hosted.composition?.publicVerdict).toBe('ALLOW');
    expect(hosted.composition?.mode).toEqual({ clauseBinding: true, quantityGrounding: true });
    expect(hosted.executor).toMatchObject({ systemVerdict: 'ALLOW', executed: true });
  });

  it('does not bind an equal cap of another order, and does not replace its limit', async () => {
    const hosted = await execute('20', '40.00', packetWithOtherOrder(), undefined, {
      extraLimits: [{
        id: 'lim-other', measure: 'share_count', unit: 'shares', referenceId: OTHER_TICKET,
        operator: '<=', value: '80', documentId: OTHER_DESK, bindingQuote: QTY_QUOTE, valueQuote: '80',
      }],
    });
    expect(hosted.composition?.proofs.find(proof => proof.clauseId === 'qty-other-order')).toMatchObject({ status: 'not_applicable', reason: 'other_order' });
    expect(hosted.composition?.replacedLimitIds).not.toContain('lim-other');
    expect(hosted.composition?.numericAfter).toBe('not_verifiable');
    expect(hosted.composition?.publicVerdict).toBe('UNCERTAIN');
    expect(hosted.executor).toMatchObject({ systemVerdict: 'UNCERTAIN', executed: false });
  });

  it('does not treat a price quotation of the same number as quantity evidence', async () => {
    const hosted = await execute('20', '20.00', standardPacket(), answer => {
      answer.grounding = [ground('at EUR 20.00 per share')];
    });
    expect(hosted.composition?.numericAfter).toBe('fulfilled');
    expect(hosted.composition?.grounding[0]).toMatchObject({ blocks: true, reason: 'no_shared_word' });
    expect(hosted.composition?.publicVerdict).toBe('UNCERTAIN');
    expect(hosted.executor).toMatchObject({ systemVerdict: 'UNCERTAIN', executed: false });
  });

  it('keeps a partial citation blocking', async () => {
    const hosted = await execute('20', '40.00', standardPacket(), answer => {
      answer.grounding = [ground('for 20')];
    });
    expect(hosted.composition?.grounding[0]).toMatchObject({ blocks: true, reason: 'no_shared_word' });
    expect(hosted.composition?.publicVerdict).toBe('UNCERTAIN');
    expect(hosted.executor?.executed).toBe(false);
  });

  it('replaces only a uniquely assigned extractor limit and leaves an unclear one', async () => {
    const unique = await execute('20', '40.00', standardPacket(), undefined, {
      extraLimits: [{
        id: 'lim-qty', measure: 'share_count', unit: 'shares', referenceId: RIVET_TICKET,
        operator: '<=', value: '80', documentId: RIVET_DESK, bindingQuote: QTY_QUOTE, valueQuote: '80',
      }],
    });
    expect(unique.frozenRunnerVerdict).toBe('UNCERTAIN');
    expect(unique.composition?.replacedLimitIds).toEqual(['lim-qty']);
    expect(unique.composition?.numericAfter).toBe('fulfilled');
    expect(unique.composition?.publicVerdict).toBe('ALLOW');
    expect(unique.executor).toMatchObject({ systemVerdict: 'ALLOW', executed: true });

    const unclear = await execute('20', '40.00', standardPacket(), undefined, {
      extraLimits: [
        {
          id: 'lim-a', measure: 'share_count', unit: 'shares', referenceId: RIVET_TICKET,
          operator: '<=', value: '80', documentId: RIVET_DESK, bindingQuote: QTY_QUOTE, valueQuote: '80',
        },
        {
          id: 'lim-b', measure: 'share_count', unit: 'shares', referenceId: RIVET_TICKET,
          operator: '<=', value: '80', documentId: RIVET_DESK, bindingQuote: QTY_QUOTE, valueQuote: '80',
        },
      ],
    });
    expect(unclear.composition?.replacedLimitIds).toEqual([]);
    expect(unclear.composition?.numericAfter).toBe('not_verifiable');
    expect(unclear.executor?.executed).toBe(false);
  });

  it('does not override an open reading or an open-condition quote', async () => {
    const open = await execute('20', '40.00', standardPacket(), answer => {
      answer.grounding = [ground(orderSentence('20', '40.00'), 'open')];
    });
    expect(open.composition?.grounding[0]).toMatchObject({ blocks: true, reason: 'reading_open_or_violated' });
    expect(open.executor?.executed).toBe(false);
    const documents = documentsFor(standardPacket(), '20', '40.00');
    documents.find(document => document.id === RIVET_DESK)!.text += 'The filing is still pending.\n';
    const answer = rivetAnswer(documents, '20', '40.00');
    answer.grounding = [ground('The filing is still pending.', 'met', RIVET_DESK)];
    const pending = composeDiagnostic(documents, JSON.stringify(answer), standardPacket(), orderFor('20', '40.00'), { clauseBinding: true, quantityGrounding: true });
    expect(pending.grounding[0]).toMatchObject({ blocks: true, reason: 'open_condition' });
    expect(pending.publicVerdict).toBe('UNCERTAIN');
  });
});
