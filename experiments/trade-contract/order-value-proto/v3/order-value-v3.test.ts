import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Document } from '../../contract.ts';
import type { HoldoutCase } from '../../direct-holdout-plan.ts';
import { coilAnswer } from './answers.ts';
import { proofMatchesClause, type AuthorizedClause, type V3Toggles } from './host.ts';
import {
  COIL_DESK, COIL_TICKET, QTY_QUOTE, boundaryClauses, documentsFor, orderFor, packetOf, standardClauses,
} from './packet.ts';
import { runPublicV3 } from './public.ts';

const originalFetch = globalThis.fetch;
const BOTH: V3Toggles = { clauseBinding: true, quantityGrounding: true };
const CHANGE_1: V3Toggles = { clauseBinding: true, quantityGrounding: false };
const CHANGE_2: V3Toggles = { clauseBinding: false, quantityGrounding: true };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubNetwork(): void {
  globalThis.fetch = () => { throw new Error('network disabled'); };
  expect(process.env.XAI_API_KEY).toBeFalsy();
}

function holdout(caseId: string, documents: HoldoutCase['documents']): HoldoutCase {
  return { caseId, documents, world: {}, action: { kind: 'OBSERVE' } };
}

function quantityRow(quote = 'for 20 SYNTH-COIL', reading: 'met' | 'open' | 'violated' = 'met', documentId = COIL_TICKET) {
  return {
    objectionId: 'qty-cap', clauseDocumentId: COIL_DESK, clauseQuote: QTY_QUOTE,
    evidenceDocumentId: documentId, evidenceQuote: quote, reading,
  };
}

async function publish(
  quantity: string,
  price: string,
  clauses: AuthorizedClause[],
  toggles: V3Toggles,
  edit?: (answer: Record<string, unknown>, documents: HoldoutCase['documents']) => void,
  mandateStatus?: 'contradicted',
  extraDocuments?: Document[],
) {
  stubNetwork();
  const mandate = packetOf(clauses);
  const documents = documentsFor(mandate, quantity, price);
  documents.push(...(extraDocuments ?? []));
  const answer = coilAnswer(documents, quantity, price, mandateStatus ? { mandateStatus } : undefined) as Record<string, unknown>;
  edit?.(answer, documents);
  const ran = await runPublicV3({
    row: holdout(`coil-${quantity}-${price}-${toggles.clauseBinding ? 'c1' : 'x'}${toggles.quantityGrounding ? 'c2' : 'x'}`, documents),
    content: JSON.stringify(answer),
    mandate, order: orderFor(quantity, price), toggles,
  });
  return ran;
}

describe('order-value v3 change 1, clause binding', () => {
  it('enforces a quantity cap and an order-value cap the extractor omitted', async () => {
    const quantity = await publish('90', '10.00', standardClauses(), CHANGE_1);
    expect(quantity.frozenRunnerVerdict).toBe('ALLOW');
    expect(quantity.frozenExecuted).toBe(true);
    expect(quantity.composition?.proofs.find(proof => proof.clauseId === 'qty-cap')).toMatchObject({
      status: 'contradicted', operator: '<=', limitValue: '80', operand: '90',
    });
    expect(quantity.composition?.numericAfter).toBe('contradicted');
    expect(quantity.composition?.publicVerdict).toBe('BLOCK');
    expect(quantity.executor).toMatchObject({ systemVerdict: 'BLOCK', executed: false });

    const value = await publish('40', '30.00', standardClauses(), CHANGE_1);
    expect(value.composition?.proofs.find(proof => proof.clauseId === 'value-cap')).toMatchObject({
      status: 'contradicted', operand: '1200', operator: '<=', limitValue: '1000.00',
    });
    expect(value.composition?.publicVerdict).toBe('BLOCK');
    expect(value.executor?.executed).toBe(false);
  });

  it('keeps the stricter cap when two clauses share a number and differ by operator', async () => {
    const onLimit = await publish('80', '10.00', boundaryClauses(), CHANGE_1);
    const strict = onLimit.composition?.proofs.find(proof => proof.clauseId === 'qty-strict');
    const inclusive = onLimit.composition?.proofs.find(proof => proof.clauseId === 'qty-inclusive');
    expect(strict).toMatchObject({ status: 'contradicted', operator: '<', limitValue: '80', operand: '80' });
    expect(inclusive).toMatchObject({ status: 'fulfilled', operator: '<=', limitValue: '80' });
    expect(proofMatchesClause(strict!, boundaryClauses()[1])).toBe(false);
    expect(onLimit.composition?.publicVerdict).toBe('BLOCK');
    expect(onLimit.executor).toMatchObject({ systemVerdict: 'BLOCK', executed: false });

    const below = await publish('79', '10.00', boundaryClauses(), CHANGE_1);
    expect(below.composition?.proofs.filter(proof => proof.unit === 'shares').every(proof => proof.status === 'fulfilled')).toBe(true);
    expect(below.composition?.publicVerdict).toBe('ALLOW');
    expect(below.executor).toMatchObject({ systemVerdict: 'ALLOW', executed: true });
  });

  it('does not clear a grounding row while change 2 is off', async () => {
    const hosted = await publish('20', '40.00', standardClauses(), CHANGE_1, answer => {
      answer.grounding = [quantityRow()];
    });
    expect(hosted.composition?.numericAfter).toBe('fulfilled');
    expect(hosted.composition?.grounding[0]).toMatchObject({ blocks: true, reason: 'frozen_heuristic' });
    expect(hosted.composition?.publicVerdict).toBe('UNCERTAIN');
    expect(hosted.executor?.executed).toBe(false);
  });
});

describe('order-value v3 change 2, quantity grounding', () => {
  it('clears only the row whose clause is the passed quantity cap and whose evidence is that quantity', async () => {
    const hosted = await publish('20', '40.00', standardClauses(), CHANGE_2, answer => {
      answer.grounding = [quantityRow()];
    });
    expect(hosted.frozenRunnerVerdict).toBe('UNCERTAIN');
    expect(hosted.composition?.numericAfter).toBe('fulfilled');
    expect(hosted.composition?.grounding[0]).toMatchObject({
      blocks: false, clauseId: 'qty-cap',
    });
    expect(hosted.composition?.grounding[0].reason).toContain('quantity_comparison_passed:qty-cap:20 <= 80');
    expect(hosted.composition?.publicVerdict).toBe('ALLOW');
    expect(hosted.executor).toMatchObject({ systemVerdict: 'ALLOW', executed: true });
  });

  it('rejects price evidence, another order, a bare met row, and open or violated readings', async () => {
    const price = await publish('20', '40.00', standardClauses(), CHANGE_2, answer => {
      answer.grounding = [quantityRow('at EUR 40.00 per share')];
    });
    expect(price.composition?.grounding[0]).toMatchObject({ blocks: true, reason: 'price_evidence' });
    expect(price.composition?.publicVerdict).toBe('UNCERTAIN');
    expect(price.executor?.executed).toBe(false);

    const other = await publish('20', '40.00', standardClauses(), CHANGE_2, answer => {
      answer.grounding = [quantityRow('for 20 SYNTH-COIL', 'met', 'other-order')];
    }, undefined, [{ id: 'other-order', role: 'source', text: 'Other order: for 20 SYNTH-COIL.\n' }]);
    expect(other.composition?.grounding[0]).toMatchObject({ blocks: true, reason: 'other_order' });
    expect(other.executor?.executed).toBe(false);

    const bare = await publish('20', '40.00', standardClauses(), CHANGE_2, answer => {
      answer.grounding = [{
        objectionId: 'strategy', clauseDocumentId: COIL_DESK,
        clauseQuote: 'Strategy: Buy SYNTH-COIL to fill the coil trial.',
        evidenceDocumentId: COIL_DESK, evidenceQuote: '80', reading: 'met',
      }];
    });
    expect(bare.composition?.grounding[0]).toMatchObject({ blocks: true, reason: 'not_the_quantity_clause' });
    expect(bare.executor?.executed).toBe(false);

    const open = await publish('20', '40.00', standardClauses(), CHANGE_2, answer => {
      answer.grounding = [quantityRow('for 20 SYNTH-COIL', 'open')];
    });
    expect(open.composition?.grounding[0]).toMatchObject({ blocks: true, reason: 'reading_open_or_violated' });
    const violated = await publish('20', '40.00', standardClauses(), CHANGE_2, answer => {
      answer.grounding = [quantityRow('for 20 SYNTH-COIL', 'violated')];
    });
    expect(violated.composition?.grounding[0].reason).toBe('reading_open_or_violated');
    expect(violated.executor?.executed).toBe(false);
  });

  it('does not itself enforce an omitted exceeded cap', async () => {
    const hosted = await publish('40', '30.00', standardClauses(), CHANGE_2);
    expect(hosted.composition?.proofs.find(proof => proof.clauseId === 'value-cap')?.status).toBe('contradicted');
    expect(hosted.composition?.numericAfter).toBe('fulfilled');
    expect(hosted.composition?.publicVerdict).toBe('ALLOW');
    expect(hosted.executor).toMatchObject({ systemVerdict: 'ALLOW', executed: true });
  });
});

describe('order-value v3 both changes, executor input', () => {
  it('executes a justified order', async () => {
    const hosted = await publish('20', '40.00', standardClauses(), BOTH, answer => {
      answer.grounding = [quantityRow()];
    });
    expect(hosted.composition?.numericAfter).toBe('fulfilled');
    expect(hosted.composition?.grounding[0].blocks).toBe(false);
    expect(hosted.composition?.publicVerdict).toBe('ALLOW');
    expect(hosted.frozenRunnerVerdict).toBe('UNCERTAIN');
    expect(hosted.executor).toMatchObject({ systemVerdict: 'ALLOW', executed: true });
  });

  it('blocks a quantity exceedance before the executor', async () => {
    const hosted = await publish('90', '10.00', standardClauses(), BOTH);
    expect(hosted.frozenRunnerVerdict).toBe('ALLOW');
    expect(hosted.frozenExecuted).toBe(true);
    expect(hosted.composition?.publicVerdict).toBe('BLOCK');
    expect(hosted.executor).toMatchObject({ systemVerdict: 'BLOCK', executed: false });
  });

  it('keeps an independent mandate contradiction blocked', async () => {
    const hosted = await publish('20', '40.00', standardClauses(), BOTH, answer => {
      answer.grounding = [quantityRow()];
    }, 'contradicted');
    expect(hosted.composition?.numericAfter).toBe('fulfilled');
    expect(hosted.composition?.grounding[0].blocks).toBe(false);
    expect(hosted.composition?.blockers.some(item => item.checkId === 'mandate_compliance' && item.status === 'contradicted')).toBe(true);
    expect(hosted.composition?.publicVerdict).toBe('BLOCK');
    expect(hosted.executor).toMatchObject({ systemVerdict: 'BLOCK', executed: false });
  });

  it('keeps its own manifest hash', () => {
    const manifestPath = new URL('./MANIFEST.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string; files: { path: string; sha256: string }[] };
    expect(manifest.version).toBe('order-value-proto/v3');
    expect(createHash('sha256').update(readFileSync(manifestPath)).digest('hex'))
      .toBe('fe67f01041e5c47aee7859f92ae733b1d1f836273607c3e2ef8cdf6b235d95a6');
    for (const file of manifest.files) {
      const bytes = readFileSync(new URL(`../../../../${file.path}`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256);
    }
  });
});
