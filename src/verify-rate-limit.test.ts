/**
 * ADR-0021 / issue #43: limiter runs before x402. Invalid Redis → 503,
 * no engine call, no billing, no settlement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_S } from './rate-limit-policy.js';

const SECRET = 'sk_test_DO_NOT_LEAK_sentinel_43';

vi.mock('./engine/index.js', () => ({
  verify: vi.fn(),
}));

vi.mock('./billing.js', () => ({
  buildBillingEvent: vi.fn(() => ({
    price_usd: 0.005,
    platform: 'direct',
  })),
  recordBillingEvent: vi.fn(async () => undefined),
}));

const x402Gate = vi.fn(async () => ({ allowed: true, paymentMethod: 'api-key' }));
vi.mock('./middleware/x402.js', () => ({
  x402Gate,
}));

import handler from '../api/sentinel/verify.js';
import { verify } from './engine/index.js';
import { recordBillingEvent } from './billing.js';
import { _resetLimiters } from './auth.js';

const verifyMock = vi.mocked(verify);
const billingMock = vi.mocked(recordBillingEvent);

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let body: unknown;
  const res = {
    setHeader(key: string, value: string) {
      headers[key] = value;
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: unknown) {
      body = data;
      return res;
    },
    end() {
      return res;
    },
  };
  return {
    res,
    headers,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
}

function verifyReq() {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sentinel-key': 'sk_test_burst',
    },
    body: {
      claim: 'Delegate refund processing to payment-agent-v2',
      evidence: 'Order #4521 refund $45 within 30-day policy. Item received.',
      mode: 'handoff',
      tier: 'checkpoint',
    },
    query: {},
  };
}

describe('POST /sentinel/verify rate-limit before x402', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    verifyMock.mockReset();
    billingMock.mockReset();
    x402Gate.mockClear();
    process.env.SERV_API_KEY = SECRET;
    delete process.env.SENTINEL_X402_ENABLED;
    delete process.env.SENTINEL_AUTH_REQUIRED;
    _resetLimiters();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetLimiters();
  });

  it('returns 503 RATE_LIMIT_UNAVAILABLE and does not call x402/engine when Redis is invalid', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'ab cd';
    _resetLimiters();

    const ctx = mockRes();
    await handler(verifyReq() as never, ctx.res as never);

    expect(ctx.statusCode).toBe(503);
    expect(ctx.headers['Retry-After']).toBe(String(RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_S));
    expect(ctx.body).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
    expect(ctx.body).not.toHaveProperty('verdict');
    expect(x402Gate).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
    expect(billingMock).not.toHaveBeenCalled();
  });
});
