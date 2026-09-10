/**
 * Model-config readiness + health/verify mapping for missing SERV_API_KEY (#32).
 */

import { afterEach, describe, expect, it } from 'vitest';
import healthHandler from '../api/sentinel/health.js';
import {
  MODEL_CONFIG_ERROR_CODE,
  MODEL_CONFIG_ERROR_MESSAGE,
  getModelReadiness,
  isModelConfigError,
  isModelConfigReady,
  modelConfigUnavailablePayload,
} from './model-config.js';

const SECRET = 'sk_test_DO_NOT_LEAK_sentinel_32';

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

describe('getModelReadiness', () => {
  it('reports present + ready when SERV_API_KEY is a non-empty string', () => {
    const readiness = getModelReadiness({ SERV_API_KEY: SECRET });
    expect(readiness).toEqual({ ready: true, serv_key: 'present' });
    expect(JSON.stringify(readiness)).not.toContain(SECRET);
  });

  it('reports missing + not ready when SERV_API_KEY is unset', () => {
    expect(getModelReadiness({})).toEqual({ ready: false, serv_key: 'missing' });
  });

  it('treats whitespace-only SERV_API_KEY as missing', () => {
    expect(getModelReadiness({ SERV_API_KEY: '   ' })).toEqual({
      ready: false,
      serv_key: 'missing',
    });
  });

  it('isModelConfigReady matches ready', () => {
    expect(isModelConfigReady({ SERV_API_KEY: SECRET })).toBe(true);
    expect(isModelConfigReady({})).toBe(false);
  });
});

describe('isModelConfigError', () => {
  it('matches pot-cli Missing env: SERV_API_KEY', () => {
    expect(isModelConfigError(new Error('Missing env: SERV_API_KEY'))).toBe(true);
  });

  it('matches wrapped callModelStructured retry errors', () => {
    expect(
      isModelConfigError(
        new Error('Failed after 3 attempts. Last error: Missing env: SERV_API_KEY'),
      ),
    ).toBe(true);
  });

  it('matches similar required model env names', () => {
    expect(isModelConfigError(new Error('Missing env: ANTHROPIC_API_KEY'))).toBe(true);
    expect(isModelConfigError(new Error('Missing env: OPENAI_API_KEY'))).toBe(true);
  });

  it('does not classify generic engine failures as config', () => {
    expect(isModelConfigError(new Error('connection reset'))).toBe(false);
    expect(isModelConfigError(new Error('INTERNAL'))).toBe(false);
    expect(isModelConfigError(new Error('Missing env: HOME'))).toBe(false);
  });
});

describe('modelConfigUnavailablePayload', () => {
  it('never includes secret material', () => {
    const payload = modelConfigUnavailablePayload('req_test');
    expect(payload).toEqual({
      error: MODEL_CONFIG_ERROR_MESSAGE,
      code: MODEL_CONFIG_ERROR_CODE,
      request_id: 'req_test',
    });
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(JSON.stringify(payload)).not.toMatch(/sk_/);
  });
});

describe('GET /sentinel/health readiness', () => {
  const original = process.env.SERV_API_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.SERV_API_KEY;
    else process.env.SERV_API_KEY = original;
  });

  it('reports serv_key present and ready when the key is set', () => {
    process.env.SERV_API_KEY = SECRET;
    const ctx = mockRes();
    healthHandler({ method: 'GET' } as never, ctx.res as never);

    expect(ctx.statusCode).toBe(200);
    expect(ctx.body).toMatchObject({
      ok: true,
      ready: true,
      serv_key: 'present',
    });
    expect(JSON.stringify(ctx.body)).not.toContain(SECRET);
  });

  it('reports serv_key missing and ready false when the key is unset', () => {
    delete process.env.SERV_API_KEY;
    const ctx = mockRes();
    healthHandler({ method: 'GET' } as never, ctx.res as never);

    expect(ctx.statusCode).toBe(200);
    expect(ctx.body).toMatchObject({
      ok: true,
      ready: false,
      serv_key: 'missing',
    });
    expect((ctx.body as { serv_key: string }).serv_key).not.toBe(SECRET);
    expect(JSON.stringify(ctx.body)).not.toContain(SECRET);
  });
});
