/**
 * Tests for Billing Event Builder + Stripe Meter Events
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildBillingEvent, recordBillingEvent } from './billing.js';
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

describe('recordBillingEvent — Stripe integration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  const mockEvent = {
    verification_id: 'sent_test001',
    tier: 'standard' as const,
    price_usd: 0.005,
    mode: 'handoff' as const,
    models_used: ['serv-nano', 'serv-pro'],
    duration_ms: 1200,
    timestamp: '2026-05-14T09:00:00.000Z',
    platform: 'openserv' as const,
    agent_id: 'agent-42',
  };

  it('logs billing event without Stripe when env vars absent', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_METER_EVENT_NAME;
    delete process.env.STRIPE_CUSTOMER_MAP;

    await recordBillingEvent(mockEvent);

    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse((console.log as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(logged.event).toBe('sentinel_billing_event');
    expect(logged.verification_id).toBe('sent_test001');
    expect(logged.price_usd).toBe(0.005);
  });

  it('submits to Stripe when fully configured', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    process.env.STRIPE_METER_EVENT_NAME = 'sentinel_verification';
    process.env.STRIPE_CUSTOMER_MAP = 'openserv:cus_abc123,acp:cus_def456';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', mockFetch);

    await recordBillingEvent(mockEvent);

    // Should have called fetch with Stripe URL
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/billing/meter_events');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer sk_test_xxx');

    // Check payload
    const body = options.body as URLSearchParams;
    expect(body.get('event_name')).toBe('sentinel_verification');
    expect(body.get('identifier')).toBe('sent_test001');
    expect(body.get('payload[stripe_customer_id]')).toBe('cus_abc123');
    expect(body.get('payload[value]')).toBe('1'); // 0.005 * 100 = 0.5, rounded = 1
    expect(body.get('payload[tier]')).toBe('standard');
    expect(body.get('payload[platform]')).toBe('openserv');
    expect(body.get('payload[agent_id]')).toBe('agent-42');

    vi.unstubAllGlobals();
  });

  it('skips Stripe when customer not in map', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    process.env.STRIPE_METER_EVENT_NAME = 'sentinel_verification';
    process.env.STRIPE_CUSTOMER_MAP = 'acp:cus_def456'; // no 'openserv' mapping

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await recordBillingEvent(mockEvent); // platform=openserv, not in map

    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('does not throw when Stripe returns error', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    process.env.STRIPE_METER_EVENT_NAME = 'sentinel_verification';
    process.env.STRIPE_CUSTOMER_MAP = 'openserv:cus_abc123';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad Request'),
    });
    vi.stubGlobal('fetch', mockFetch);

    // Should not throw
    await expect(recordBillingEvent(mockEvent)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('does not throw when fetch fails', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    process.env.STRIPE_METER_EVENT_NAME = 'sentinel_verification';
    process.env.STRIPE_CUSTOMER_MAP = 'openserv:cus_abc123';

    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    await expect(recordBillingEvent(mockEvent)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
