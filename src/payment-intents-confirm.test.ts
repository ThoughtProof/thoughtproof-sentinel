/**
 * ADR-0021: payment-intents confirm is directly reachable (not via verify).
 * Unreachable / invalid Redis must stay non-2xx and must not settle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetSharedUpstashRedis } from './upstash-config.js';

const setMock = vi.fn();
const getMock = vi.fn();
const delMock = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    set: setMock,
    get: getMock,
    del: delMock,
  })),
}));

import handler from '../api/sentinel/payment-intents/[id]/confirm.js';

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

function confirmReq() {
  return {
    method: 'POST',
    url: '/sentinel/payment-intents/pi_testIntent99/confirm',
    headers: { 'content-type': 'application/json' },
    body: { txHash: '0xabc123def' },
  };
}

describe('POST /sentinel/payment-intents/:id/confirm Redis unavailable', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setMock.mockReset();
    getMock.mockReset();
    delMock.mockReset();
    _resetSharedUpstashRedis();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetSharedUpstashRedis();
  });

  it('returns non-2xx and does not settle when Redis env is invalid', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'ab cd';
    _resetSharedUpstashRedis();

    const ctx = mockRes();
    await handler(confirmReq() as never, ctx.res as never);

    expect(ctx.statusCode).toBeGreaterThanOrEqual(400);
    expect(ctx.statusCode).toBeLessThan(600);
    expect(ctx.statusCode).not.toBe(200);
    expect(ctx.statusCode).not.toBe(201);
    expect(ctx.body).toMatchObject({ error: 'Payment intent storage unavailable' });
    expect(ctx.body).not.toMatchObject({ status: 'paid' });
    expect(JSON.stringify(ctx.body)).not.toMatch(/paid_at|Payment confirmed/);
    expect(setMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('returns non-2xx and does not settle when Redis env is unset', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    _resetSharedUpstashRedis();

    const ctx = mockRes();
    await handler(confirmReq() as never, ctx.res as never);

    expect(ctx.statusCode).toBeGreaterThanOrEqual(400);
    expect(ctx.statusCode).not.toBe(200);
    expect(ctx.body).not.toMatchObject({ status: 'paid' });
    expect(setMock).not.toHaveBeenCalled();
  });
});
