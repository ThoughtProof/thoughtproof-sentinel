/**
 * Tests for x402 Payment Middleware
 *
 * Tests gate logic: bypass paths (API key, platform, disabled) and 402 challenge generation.
 * Does NOT test facilitator HTTP calls (mocked) or Redis (unit-tested via auth tests).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { x402Gate } from './x402.js';

// Mock Redis to avoid Upstash dependency in tests
vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
  })),
}));

function mockReq(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return {
    method: 'POST',
    url: '/sentinel/verify',
    headers: {},
    body: { claim: 'test', evidence: 'test', mode: 'handoff' },
    ...overrides,
  } as unknown as VercelRequest;
}

function mockRes(): VercelResponse & { _status: number; _json: unknown; _headers: Record<string, string> } {
  const res = {
    _status: 200,
    _json: null,
    _headers: {} as Record<string, string>,
    status(code: number) { res._status = code; return res; },
    json(data: unknown) { res._json = data; return res; },
    setHeader(name: string, value: string) { res._headers[name] = value; return res; },
  };
  return res as unknown as VercelResponse & typeof res;
}

describe('x402Gate', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  describe('when x402 disabled (default)', () => {
    it('allows all requests', async () => {
      delete process.env.SENTINEL_X402_ENABLED;
      const result = await x402Gate(mockReq(), mockRes());
      expect(result.allowed).toBe(true);
      expect(result.paymentMethod).toBe('api-key');
    });
  });

  describe('when x402 enabled', () => {
    beforeEach(() => {
      vi.stubEnv('SENTINEL_X402_ENABLED', 'true');
      vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://fake.upstash.io');
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'fake-token');
    });

    it('bypasses payment for API key holders', async () => {
      const req = mockReq({ headers: { 'x-sentinel-key': 'sk_test_123' } as any });
      const result = await x402Gate(req, mockRes());
      expect(result.allowed).toBe(true);
      expect(result.paymentMethod).toBe('api-key');
    });

    it('bypasses payment for OpenServ platform traffic', async () => {
      const req = mockReq({ headers: { 'x-sentinel-platform': 'openserv' } as any });
      const result = await x402Gate(req, mockRes());
      expect(result.allowed).toBe(true);
      expect(result.paymentMethod).toBe('platform-bypass');
    });

    it('bypasses payment for ACP platform traffic', async () => {
      const req = mockReq({ headers: { 'x-sentinel-platform': 'acp' } as any });
      const result = await x402Gate(req, mockRes());
      expect(result.allowed).toBe(true);
      expect(result.paymentMethod).toBe('platform-bypass');
    });

    it('returns 402 challenge when no payment provided', async () => {
      const res = mockRes();
      const result = await x402Gate(mockReq(), res);
      expect(result.allowed).toBe(false);
      expect(res._status).toBe(402);
      expect(res._json).toHaveProperty('protocol', 'x402');
      expect(res._json).toHaveProperty('intentId');
      expect(res._json).toHaveProperty('payment');
    });

    it('includes x402 v2 payment-required header advertising both base network tokens', async () => {
      const res = mockRes();
      await x402Gate(mockReq(), res);
      expect(res._headers['payment-required']).toBeDefined();
      const challenge = JSON.parse(Buffer.from(res._headers['payment-required'], 'base64').toString());
      expect(challenge.x402Version).toBe(2);
      // Dual-format: both CAIP-2 ("eip155:8453") and legacy string ("base") are advertised
      // so spec-compliant clients AND legacy clients (x402scan, AgentCash) can both pay.
      expect(challenge.accepts).toHaveLength(2);
      const networks = challenge.accepts.map((a: { network: string }) => a.network);
      expect(networks).toContain('eip155:8453');
      expect(networks).toContain('base');
      for (const a of challenge.accepts) {
        expect(a.scheme).toBe('exact');
        expect(a.asset).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
        // every accepts entry must be a fully-formed paymentRequirements object
        expect(a.maxAmountRequired).toBeDefined();
        expect(a.resource).toBe('https://sentinel.thoughtproof.ai/sentinel/verify');
        expect(a.payTo).toBeDefined();
      }
    });

    it('includes payment intent instructions', async () => {
      const res = mockRes();
      await x402Gate(mockReq(), res);
      const body = res._json as { instructions: string[] };
      expect(body.instructions).toHaveLength(4);
      expect(body.instructions[0]).toContain('PAYMENT-SIGNATURE');
    });

    it('rejects invalid base64 in PAYMENT-SIGNATURE', async () => {
      const req = mockReq({ headers: { 'payment-signature': 'not-valid-base64!@#' } as any });
      const res = mockRes();
      const result = await x402Gate(req, res);
      expect(result.allowed).toBe(false);
      expect(res._status).toBe(402);
    });

    it('does not bypass for unknown platform', async () => {
      const req = mockReq({ headers: { 'x-sentinel-platform': 'unknown' } as any });
      const res = mockRes();
      const result = await x402Gate(req, res);
      expect(result.allowed).toBe(false);
      expect(res._status).toBe(402);
    });
  });
});
