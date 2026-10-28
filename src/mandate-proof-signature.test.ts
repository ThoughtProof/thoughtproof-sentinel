/**
 * Stage-4 signature transport. Offline. No network and no provider keys.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeMandate, verdictWithMandateNormalization } from './mandate-normalize.js';
import {
  MANDATE_PROOF_SIGNATURE_PATTERN,
  parseMandateProofSignature,
  stage4TransportAccepts,
} from './mandate-proof-signature.js';

const HEX = 'ab'.repeat(64);
const TRANSFER = {
  kind: 'value_transfer',
  action: { kind: 'value_transfer', amount: 1, asset: 'USDC', recipient: 'r' },
};

describe('mandate proof signature transport', () => {
  it('accepts only 128 lowercase hex characters', () => {
    expect(MANDATE_PROOF_SIGNATURE_PATTERN.test(HEX)).toBe(true);
    const parsed = parseMandateProofSignature(HEX);
    expect(parsed).toEqual({ ok: true, signature: HEX });
    expect(parsed).not.toHaveProperty('verdict');
    expect(JSON.stringify(parsed)).not.toContain('ALLOW');
  });

  it('rejects a prefix, uppercase, whitespace, and the wrong length', () => {
    const rejected = [
      `0x${HEX}`,
      `0X${HEX}`,
      HEX.toUpperCase(),
      ` ${HEX}`,
      `${HEX} `,
      HEX.slice(0, 127),
      `${HEX}a`,
      '',
      'not-a-signature',
      1,
      null,
      undefined,
    ];
    for (const value of rejected) {
      const result = parseMandateProofSignature(value);
      expect(result).toEqual({ ok: false, verdict: 'BLOCK', reason: 'malformed_signature' });
      expect(JSON.stringify(result)).not.toContain('ALLOW');
    }
  });

  it('does not bind an incomplete mandate or a non-canonical signature', () => {
    const incomplete = normalizeMandate({ action: { kind: 'permission', allowance: '1' } });
    const goodSig = parseMandateProofSignature(HEX);
    expect(incomplete.ok).toBe(false);
    expect(stage4TransportAccepts(incomplete, goodSig)).toBe(false);
    expect(verdictWithMandateNormalization('ALLOW', incomplete, true)).toBe('BLOCK');

    const complete = normalizeMandate(TRANSFER);
    expect(complete.ok).toBe(true);
    expect(stage4TransportAccepts(complete, parseMandateProofSignature(`0x${HEX}`))).toBe(false);
    expect(stage4TransportAccepts(complete, goodSig)).toBe(true);
    expect(verdictWithMandateNormalization('BLOCK', complete, true)).toBe('BLOCK');
    expect(verdictWithMandateNormalization('ALLOW', complete, true)).toBe('ALLOW');
    expect(complete).not.toHaveProperty('verdict');
  });

  it('is not imported by the verify handler', () => {
    const source = readFileSync(new URL('./mandate-proof-signature.ts', import.meta.url), 'utf8');
    const verify = readFileSync(new URL('../api/sentinel/verify.ts', import.meta.url), 'utf8');
    const manifest = readFileSync(new URL('./principal-key-manifest.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('toLowerCase');
    expect(source).not.toContain('api/sentinel');
    expect(source).not.toContain('src/engine');
    expect(verify).not.toContain('mandate-proof-signature');
    expect(verify).not.toContain('parseMandateProofSignature');
    expect(manifest).not.toContain('mandate-proof-signature');
  });
});
