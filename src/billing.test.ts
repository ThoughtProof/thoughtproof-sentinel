/**
 * Tests for Billing Event Builder
 */

import { describe, it, expect } from 'vitest';
import { buildBillingEvent } from './billing.js';
import type { SentinelVerifyResponse } from './types.js';

describe('buildBillingEvent', () => {
  const mockResponse: SentinelVerifyResponse = {
    id: 'sent_abc123',
    verdict: 'ALLOW',
    confidence: 0.875,
    reasoning: 'Output aligns with context.',
    mode: 'handoff',
    tier: 'standard',
    meta: {
      duration_ms: 1200,
      models_used: ['serv-nano', 'serv-pro'],
      verified_at: '2026-05-13T18:30:00.000Z',
    },
  };

  it('builds correct billing event for standard tier', () => {
    const event = buildBillingEvent(mockResponse, {
      platform: 'openserv',
      agent_id: 'agent-42',
    });

    expect(event.verification_id).toBe('sent_abc123');
    expect(event.tier).toBe('standard');
    expect(event.price_usd).toBe(0.005);
    expect(event.mode).toBe('handoff');
    expect(event.models_used).toEqual(['serv-nano', 'serv-pro']);
    expect(event.duration_ms).toBe(1200);
    expect(event.platform).toBe('openserv');
    expect(event.agent_id).toBe('agent-42');
  });

  it('uses checkpoint price for checkpoint tier', () => {
    const checkpointRes = { ...mockResponse, tier: 'checkpoint' as const };
    const event = buildBillingEvent(checkpointRes, { platform: 'direct' });

    expect(event.price_usd).toBe(0.003);
    expect(event.agent_id).toBeUndefined();
  });

  it('handles ACP platform', () => {
    const event = buildBillingEvent(mockResponse, {
      platform: 'acp',
      agent_id: '0xABC123',
    });

    expect(event.platform).toBe('acp');
    expect(event.agent_id).toBe('0xABC123');
  });
});
