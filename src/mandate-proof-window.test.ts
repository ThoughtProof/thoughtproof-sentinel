/**
 * Offline checks for ADR-0023 proof windows.
 * Pure functions and a caller-supplied clock. No network and no provider keys.
 */
import { describe, expect, it } from 'vitest';
import {
  checkMandateProofTimes,
  checkWindowThenConsume,
  recheckExpiryBeforeNonceConsumption,
} from './mandate-proof-window.js';

const IAT = 1_780_000_000;
const NOW = IAT + 10;

describe('mandate proof window', () => {
  it('rejects iat == exp', () => {
    const result = checkMandateProofTimes({ iat: IAT, exp: IAT }, NOW);
    expect(result).toEqual({ ok: false, verdict: 'BLOCK', reason: 'non_positive_window' });
  });

  it('rejects exp < iat', () => {
    const result = checkMandateProofTimes({ iat: IAT, exp: IAT - 1 }, NOW);
    expect(result).toEqual({ ok: false, verdict: 'BLOCK', reason: 'non_positive_window' });
  });

  it('accepts a strictly positive window inside the skew and the 5-minute cap', () => {
    const result = checkMandateProofTimes({ iat: IAT, exp: IAT + 60 }, NOW);
    expect(result).toEqual({ ok: true });
    expect(result).not.toHaveProperty('verdict', 'ALLOW');
  });

  it('rejects a proof that expires between validation and nonce consumption', () => {
    const times = { iat: IAT, exp: IAT + 60 };
    const nowAtValidation = IAT + 10;
    const validated = checkMandateProofTimes(times, nowAtValidation);
    expect(validated).toEqual({ ok: true });

    // Fake clock: receipt time moves to the first second where
    // exp > now - 30 no longer holds (now = exp + skew).
    const nowAtConsumption = times.exp + 30;
    const consumed = recheckExpiryBeforeNonceConsumption(times, nowAtConsumption);
    expect(consumed).toEqual({ ok: false, verdict: 'BLOCK', reason: 'expired' });

    const sequenced = checkWindowThenConsume(times, nowAtValidation, nowAtConsumption);
    expect(sequenced).toEqual({ ok: false, verdict: 'BLOCK', reason: 'expired' });
    expect(sequenced).not.toMatchObject({ verdict: 'ALLOW' });
  });
});
