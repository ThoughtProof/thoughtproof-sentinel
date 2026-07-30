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

  it('accepts all 6 modes', () => {
    for (const mode of ['handoff', 'plan_revision', 'memory_write', 'output_synthesis', 'trade_execution', 'trade_reasoning']) {
      const result = validateVerifyRequest({ ...validBody, mode });
      expect(result.valid).toBe(true);
    }
  });

  it('accepts all tiers', () => {
    for (const tier of ['checkpoint', 'standard', 'swift']) {
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

  it('accepts optional agent_context and trims strings', () => {
    const result = validateVerifyRequest({
      ...validBody,
      agent_context: {
        agent_id: '  tp-pilot-1  ',
        agent_model: 'xai/grok-4',
        agent_runtime: 'cb4a',
        environment: 'paper',
        erc8004: { chainId: 8453, tokenId: 37477 },
        request_id: 'req_abc',
        tags: ['intuition-pilot'],
      },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.agent_context).toEqual({
        agent_id: 'tp-pilot-1',
        agent_model: 'xai/grok-4',
        agent_model_source: 'operator_declared',
        agent_model_role: 'action_generator',
        agent_runtime: 'cb4a',
        environment: 'paper',
        erc8004: { chainId: 8453, tokenId: 37477 },
        identity_source: 'operator_declared',
        identity_verified: false,
        external_request_id: 'req_abc',
        tags: ['intuition-pilot'],
      });
    }
  });

  it('rejects identity_verified=true with operator_declared', () => {
    const result = validateVerifyRequest({
      ...validBody,
      agent_context: {
        agent_id: 'x',
        identity_source: 'operator_declared',
        identity_verified: true,
      },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid agent_model_source', () => {
    const result = validateVerifyRequest({
      ...validBody,
      agent_context: { agent_model: 'x', agent_model_source: 'guessed' },
    });
    expect(result.valid).toBe(false);
  });

  it('normalizes mandate maxAmountUsd/amountUsd aliases for the gate', () => {
    const result = validateVerifyRequest({
      ...validBody,
      mode: 'action_authorization',
      mandate: {
        granted: { maxAmountUsd: 0, asset: 'USDC' },
        action: { amountUsd: 500, asset: 'USDC' },
      },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.mandate?.granted?.maxAmount).toBe(0);
      expect(result.data.mandate?.action?.amount).toBe(500);
    }
  });
});
