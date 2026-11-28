import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADAPTER_ID, decideCascade } from '../adapter.ts';
import { applySharedHost, prepareModelContent } from '../comparison-grounding.ts';
import { extractorAnswer } from './answers.ts';
import { synthDocuments } from './cases.ts';
import { applyOrderValueHost, assessOrderValue } from './host.ts';

function frozen(documents: ReturnType<typeof synthDocuments>, includeCapLimit: boolean) {
  const content = JSON.stringify(extractorAnswer(documents, { includeCapLimit }));
  const prepared = prepareModelContent(content, documents, 'primary');
  const decided = decideCascade(documents, { ok: true, content: prepared.publicContent }, null, {
    trustedAdapterIds: [ADAPTER_ID], diagnostics: true,
  });
  const blocking = decided.checks.find(check => check.status === 'not_verifiable' || check.status === 'contradicted');
  return {
    frozen: decided.decision,
    publicVerdict: applySharedHost(decided.decision, prepared.grounding, documents),
    decidingCheck: blocking ? `${blocking.checkId} ${blocking.status}` : null,
    diagnostics: (decided.diagnostics ?? []).map(item => `${item.code}@${item.path}`),
  };
}

describe('order-value prototype', () => {
  it('omitting the cap at the frozen gate yields ALLOW', () => {
    const documents = synthDocuments('40', '30.00');
    const without = frozen(documents, false);
    const withCap = frozen(documents, true);
    expect(without.publicVerdict).toBe('ALLOW');
    expect(without.decidingCheck).toBeNull();
    expect(withCap.publicVerdict).toBe('UNCERTAIN');
    expect(withCap.decidingCheck).toBe('numeric_limits not_verifiable');
    expect(withCap.diagnostics.some(item => item.startsWith('UNBOUND_NUMERIC_COMPARISON'))).toBe(true);
  });

  it('blocks the product when the extractor omits an exceeded cap', () => {
    const documents = synthDocuments('40', '30.00');
    const gate = frozen(documents, false);
    const hosted = applyOrderValueHost(documents, gate.publicVerdict);
    expect(gate.publicVerdict).toBe('ALLOW');
    expect(hosted.status).toBe('contradicted');
    expect(hosted.calculation?.result).toBe('1200');
    expect(hosted.calculation?.formula).toBe('quantity * limit_price');
    expect(hosted.publicVerdict).toBe('BLOCK');
  });

  it('allows a product below and exactly on an inclusive cap', () => {
    const below = synthDocuments('20', '40.00');
    const exact = synthDocuments('25', '40.00');
    const belowHost = applyOrderValueHost(below, frozen(below, false).publicVerdict);
    const exactHost = applyOrderValueHost(exact, frozen(exact, false).publicVerdict);
    expect(belowHost.status).toBe('fulfilled');
    expect(belowHost.calculation?.result).toBe('800');
    expect(belowHost.publicVerdict).toBe('ALLOW');
    expect(exactHost.status).toBe('fulfilled');
    expect(exactHost.calculation?.result).toBe('1000');
    expect(exactHost.publicVerdict).toBe('ALLOW');
  });

  it('is UNCERTAIN when an operand or the cap is missing or not unique', () => {
    const missing = [{ id: 'syn-desk', role: 'source' as const, text: synthDocuments('40', '30.00')[0].text },
      { id: 'syn-ticket', role: 'proposal' as const, text: 'Limit buy of SYNTH-WIDGET with no quantity.\n' }];
    expect(assessOrderValue(missing).status).toBe('not_verifiable');
    expect(assessOrderValue(missing).reason).toBe('operand_not_unique');
    const twoPrices = synthDocuments('40', '30.00', { secondPrice: '20.00' });
    expect(assessOrderValue(twoPrices).reason).toBe('operand_not_unique');
    const twoCaps = synthDocuments('40', '30.00', { secondCap: '900.00' });
    expect(assessOrderValue(twoCaps).reason).toBe('cap_not_unique');
    expect(applyOrderValueHost(twoCaps, 'ALLOW').publicVerdict).toBe('UNCERTAIN');
  });

  it('keeps its own manifest hash apart from the frozen candidate', () => {
    const manifestPath = new URL('./MANIFEST.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string; files: { path: string; sha256: string }[] };
    expect(manifest.version).toBe('order-value-proto/v1');
    expect(createHash('sha256').update(readFileSync(manifestPath)).digest('hex'))
      .toBe('77197a0d1f925a25d6b58179873f8aaa9d1bf8ea31c8d2012c80178491d39424');
    for (const file of manifest.files) {
      const bytes = readFileSync(new URL(`../../../${file.path}`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256);
    }
  });

  it('does not use a different market price as the limit-price operand', () => {
    const documents = synthDocuments('40', '20.00', { extra: 'Market price: EUR 45.00 per share.' });
    const hosted = applyOrderValueHost(documents, frozen(documents, false).publicVerdict);
    expect(hosted.calculation?.limitPrice).toBe('20.00');
    expect(hosted.calculation?.result).toBe('800');
    expect(hosted.status).toBe('fulfilled');
    expect(hosted.publicVerdict).toBe('ALLOW');
  });
});
