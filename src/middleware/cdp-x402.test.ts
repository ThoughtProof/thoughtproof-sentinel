/**
 * Tests for CDP facilitator integration (cdp-jwt.ts + CDP mode in x402.ts).
 *
 * Covers:
 *  - JWT generation: structure, claims (uri = METHOD host+path), Ed25519 signature verifies
 *  - Gate CDP mode: when X402_CDP_KEY_ID/SECRET are set, facilitator calls go to
 *    api.cdp.coinbase.com with Bearer auth and the v2 payload shape (accepted/payload/resource)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPrivateKey, createPublicKey, verify as cryptoVerify } from 'crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { generateCdpJwt } from './cdp-jwt.js';

// Mock Redis to avoid Upstash dependency (needed when importing x402.js)
vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
  })),
}));

// 64-byte test keypair (32B seed + 32B pubkey, all deterministic bytes)
const TEST_SECRET = Buffer.from(Array.from({ length: 64 }, (_, i) => i % 256)).toString('base64');
const TEST_KEY_ID = '11111111-2222-3333-4444-555555555555';
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

describe('generateCdpJwt', () => {
  it('produces a 3-part JWT with correct header and claims', () => {
    const token = generateCdpJwt(TEST_KEY_ID, TEST_SECRET, 'POST', 'api.cdp.coinbase.com', '/platform/v2/x402/verify');
    const [h, p, sig] = token.split('.');
    expect(sig.length).toBeGreaterThan(0);

    const header = JSON.parse(b64urlDecode(h).toString());
    expect(header.alg).toBe('EdDSA');
    expect(header.kid).toBe(TEST_KEY_ID);
    expect(header.typ).toBe('JWT');
    expect(header.nonce).toBeTruthy();

    const payload = JSON.parse(b64urlDecode(p).toString());
    expect(payload.sub).toBe(TEST_KEY_ID);
    expect(payload.iss).toBe('cdp');
    expect(payload.uri).toBe('POST api.cdp.coinbase.com/platform/v2/x402/verify');
    expect(payload.exp - payload.nbf).toBe(120);
  });

  it('signature verifies against the Ed25519 public key derived from the secret', () => {
    const token = generateCdpJwt(TEST_KEY_ID, TEST_SECRET, 'POST', 'api.cdp.coinbase.com', '/platform/v2/x402/settle');
    const [h, p, sig] = token.split('.');

    const seed = b64urlDecode(TEST_SECRET).subarray(0, 32);
    const pkcs8 = Buffer.concat([PKCS8_PREFIX, seed]);
    const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
    const pub = createPublicKey(priv);

    const ok = cryptoVerify(null, Buffer.from(`${h}.${p}`), pub, b64urlDecode(sig));
    expect(ok).toBe(true);
  });

  it('rejects secrets that do not decode to 64 bytes', () => {
    expect(() => generateCdpJwt(TEST_KEY_ID, Buffer.from('short').toString('base64'), 'POST', 'h', '/p')).toThrow(/64 bytes/);
  });
});

describe('x402Gate CDP mode', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function paymentSignatureHeader(): string {
    const payload = {
      x402Version: 1,
      scheme: 'exact',
      network: 'eip155:8453',
      payload: {
        signature: '0x' + 'ab'.repeat(65),
        authorization: {
          from: '0x369301753a2372304ba4e159bab852339d760989',
          to: '0xAB9f84864662f980614bD1453dB9950Ef2b82E83',
          value: '5000',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x' + 'cd'.repeat(32),
        },
      },
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  function mockRes(): VercelResponse & { _status: number; _json: unknown } {
    const res = {
      _status: 200,
      _json: null as unknown,
      _headers: {} as Record<string, string>,
      status(code: number) { res._status = code; return res; },
      json(data: unknown) { res._json = data; return res; },
      setHeader(name: string, value: string) { res._headers[name] = value; return res; },
    };
    return res as unknown as VercelResponse & typeof res;
  }

  it('sends v2-shaped body with Bearer JWT to the CDP facilitator', async () => {
    vi.stubEnv('SENTINEL_X402_ENABLED', 'true');
    vi.stubEnv('X402_CDP_KEY_ID', TEST_KEY_ID);
    vi.stubEnv('X402_CDP_KEY_SECRET', TEST_SECRET);

    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit });
      const isVerify = String(url).endsWith('/verify');
      return {
        ok: true,
        json: async () => isVerify
          ? { isValid: true, payer: '0x369301753a2372304ba4e159bab852339d760989' }
          : { success: true, transaction: '0xdeadbeef', network: 'eip155:8453' },
      } as Response;
    }) as unknown as typeof fetch;

    const { x402Gate } = await import('./x402.js');
    const req = {
      method: 'POST',
      url: '/sentinel/verify',
      headers: { 'payment-signature': paymentSignatureHeader() },
      body: { claim: 'test', evidence: 'test', mode: 'handoff' },
    } as unknown as VercelRequest;

    const res = mockRes();
    const result = await x402Gate(req, res);

    expect(result.allowed).toBe(true);
    expect(calls.length).toBe(2);

    const [verifyCall, settleCall] = calls;
    expect(verifyCall.url).toBe('https://api.cdp.coinbase.com/platform/v2/x402/verify');
    expect(settleCall.url).toBe('https://api.cdp.coinbase.com/platform/v2/x402/settle');

    const headers = verifyCall.init.headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(/^Bearer eyJ/);

    const body = JSON.parse(String(verifyCall.init.body));
    expect(body.x402Version).toBe(2);
    expect(body.paymentPayload.x402Version).toBe(2);
    expect(body.paymentPayload.accepted.scheme).toBe('exact');
    expect(body.paymentPayload.accepted.network).toBe('eip155:8453');
    // Default public tier is checkpoint ($0.005) since catalog consolidation (660e1bc).
    expect(body.paymentPayload.accepted.amount).toBe('5000'); // checkpoint tier $0.005 (server-side pricing)
    expect(body.paymentPayload.payload.signature).toBe('0x' + 'ab'.repeat(65));
    expect(body.paymentPayload.resource.url).toContain('sentinel.thoughtproof.ai');
    expect(body.paymentRequirements.network).toBe('eip155:8453');

    const settleBody = JSON.parse(String(settleCall.init.body));
    expect(settleBody.x402Version).toBe(2);
    expect(settleBody.paymentPayload.accepted).toBeTruthy();
  });
});
