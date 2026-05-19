import { describe, expect, it } from 'vitest';
import { validateVerifyRequest } from './validation.js';

describe('validateVerifyRequest', () => {
  const validBody = {
    claim: 'Agent decided to transfer funds',
    evidence: 'Policy requires approval for transfers > $1000. Transfer amount: $500.',
    mode: 'handoff',
  };

  it('accepts valid minimal request', () => {
    const result = validateVerifyRequest(validBody);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.tier).toBe('standard');
      expect(result.data.mode).toBe('handoff');
    }
  });

  it('accepts all 5 modes', () => {
    for (const mode of ['handoff', 'plan_revision', 'memory_write', 'output_synthesis', 'trade_execution']) {
      const result = validateVerifyRequest({ ...validBody, mode });
      expect(result.valid).toBe(true);
    }
  });

  it('accepts both tiers', () => {
    for (const tier of ['checkpoint', 'standard']) {
      const result = validateVerifyRequest({ ...validBody, tier });
      expect(result.valid).toBe(true);
    }
  });

  it('rejects missing claim', () => {
    const result = validateVerifyRequest({ evidence: 'x', mode: 'handoff' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe('claim');
    }
  });

  it('rejects missing evidence', () => {
    const result = validateVerifyRequest({ claim: 'x', mode: 'handoff' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe('evidence');
    }
  });

  it('rejects invalid mode', () => {
    const result = validateVerifyRequest({ ...validBody, mode: 'invalid' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe('mode');
    }
  });

  it('rejects invalid tier', () => {
    const result = validateVerifyRequest({ ...validBody, tier: 'premium' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe('tier');
    }
  });

  it('rejects non-object body', () => {
    const result = validateVerifyRequest(null);
    expect(result.valid).toBe(false);
  });
});
