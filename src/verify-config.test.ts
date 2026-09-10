/**
 * POST /sentinel/verify maps missing model config to 503 MODEL_CONFIG_MISSING.
 * Engine is mocked — these tests never call a live provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_CONFIG_ERROR_CODE,
  MODEL_CONFIG_ERROR_MESSAGE,
} from './model-config.js';

const SECRET = 'sk_test_DO_NOT_LEAK_sentinel_32';

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

import handler from '../api/sentinel/verify.js';
import { verify } from './engine/index.js';

const verifyMock = vi.mocked(verify);

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
    headers: { 'content-type': 'application/json' },
    body: {
      claim: 'Delegate refund processing to payment-agent-v2',
      evidence: 'Order #4521 refund $45 within 30-day policy. Item received.',
      mode: 'handoff',
      tier: 'checkpoint',
    },
    query: {},
  };
}

describe('POST /sentinel/verify model config', () => {
  const savedServ = process.env.SERV_API_KEY;
  const savedX402 = process.env.SENTINEL_X402_ENABLED;
  const savedAuth = process.env.SENTINEL_AUTH_REQUIRED;

  beforeEach(() => {
    verifyMock.mockReset();
    delete process.env.SENTINEL_X402_ENABLED;
    delete process.env.SENTINEL_AUTH_REQUIRED;
  });

  afterEach(() => {
    if (savedServ === undefined) delete process.env.SERV_API_KEY;
    else process.env.SERV_API_KEY = savedServ;
    if (savedX402 === undefined) delete process.env.SENTINEL_X402_ENABLED;
    else process.env.SENTINEL_X402_ENABLED = savedX402;
    if (savedAuth === undefined) delete process.env.SENTINEL_AUTH_REQUIRED;
    else process.env.SENTINEL_AUTH_REQUIRED = savedAuth;
  });

  it('returns 503 MODEL_CONFIG_MISSING when SERV_API_KEY is missing (no engine call)', async () => {
    delete process.env.SERV_API_KEY;
    const ctx = mockRes();
    await handler(verifyReq() as never, ctx.res as never);

    expect(verifyMock).not.toHaveBeenCalled();
    expect(ctx.statusCode).toBe(503);
    expect(ctx.body).toMatchObject({
      error: MODEL_CONFIG_ERROR_MESSAGE,
      code: MODEL_CONFIG_ERROR_CODE,
    });
    expect((ctx.body as { code: string }).code).not.toBe('INTERNAL_ERROR');
    expect((ctx.body as { request_id: string }).request_id).toMatch(/^req_/);
    expect(ctx.body).not.toHaveProperty('verdict');
    expect(JSON.stringify(ctx.body)).not.toContain(SECRET);
    expect(JSON.stringify(ctx.body)).not.toMatch(/sk_[a-zA-Z0-9]/);
  });

  it('returns 503 when the engine throws pot-cli Missing env: SERV_API_KEY', async () => {
    process.env.SERV_API_KEY = SECRET;
    verifyMock.mockRejectedValue(new Error('Missing env: SERV_API_KEY'));
    const ctx = mockRes();
    await handler(verifyReq() as never, ctx.res as never);

    expect(verifyMock).toHaveBeenCalledOnce();
    expect(ctx.statusCode).toBe(503);
    expect(ctx.body).toMatchObject({
      error: MODEL_CONFIG_ERROR_MESSAGE,
      code: MODEL_CONFIG_ERROR_CODE,
    });
    expect(JSON.stringify(ctx.body)).not.toContain(SECRET);
    expect(JSON.stringify(ctx.body)).not.toContain('Missing env');
  });

  it('does not 503 when the key is present and the engine returns a real verdict', async () => {
    process.env.SERV_API_KEY = SECRET;
    verifyMock.mockResolvedValue({
      id: 'sent_cfg_001',
      verdict: 'UNCERTAIN',
      confidence: 0.4,
      reasoning: 'insufficient evidence',
      objections: [],
      mode: 'handoff',
      tier: 'checkpoint',
      meta: {
        duration_ms: 10,
        models_used: ['serv-nano'],
        verified_at: '2026-09-10T00:00:00.000Z',
      },
    });
    const ctx = mockRes();
    await handler(verifyReq() as never, ctx.res as never);

    expect(verifyMock).toHaveBeenCalledOnce();
    expect(ctx.statusCode).toBe(200);
    expect((ctx.body as { verdict: string }).verdict).toBe('UNCERTAIN');
    expect((ctx.body as { verdict: string }).verdict).not.toBe('ALLOW');
    expect(JSON.stringify(ctx.body)).not.toContain(SECRET);
  });

  it('keeps generic failures as 500 INTERNAL_ERROR', async () => {
    process.env.SERV_API_KEY = SECRET;
    verifyMock.mockRejectedValue(new Error('cascade timeout'));
    const ctx = mockRes();
    await handler(verifyReq() as never, ctx.res as never);

    expect(ctx.statusCode).toBe(500);
    expect(ctx.body).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
