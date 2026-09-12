/**
 * Published /docs + /redoc viewers over live /openapi.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import docsHandler from '../api/docs.js';
import redocHandler from '../api/redoc.js';
import {
  OPENAPI_SPEC_URL,
  redocHtml,
  sendDocsHtml,
  swaggerUiHtml,
} from './openapi-docs.js';

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
    end(data?: string) {
      if (data !== undefined) body = data;
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

describe('openapi docs HTML', () => {
  it('Swagger UI and ReDoc both load the live OpenAPI document', () => {
    const swagger = swaggerUiHtml();
    const redoc = redocHtml();
    expect(OPENAPI_SPEC_URL).toBe('/openapi.json');
    expect(swagger).toContain('/openapi.json');
    expect(swagger).toContain('swagger-ui');
    expect(swagger).toContain('SwaggerUIBundle');
    expect(redoc).toContain('/openapi.json');
    expect(redoc).toContain('redoc');
    expect(redoc).toContain('spec-url="/openapi.json"');
  });

  it('escapes a custom spec URL in HTML attributes', () => {
    const html = redocHtml('https://example.test/openapi.json?q="><script>');
    expect(html).not.toContain('"><script>');
    expect(html).toContain('spec-url="https://example.test/openapi.json?q=&quot;&gt;&lt;script&gt;"');
  });
});

describe('sendDocsHtml', () => {
  it('GET returns 200 HTML', () => {
    const ctx = mockRes();
    sendDocsHtml({ method: 'GET' }, ctx.res, swaggerUiHtml());
    expect(ctx.statusCode).toBe(200);
    expect(ctx.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(String(ctx.body)).toContain('SwaggerUIBundle');
    expect(String(ctx.body)).toContain('/openapi.json');
  });

  it('HEAD returns 200 without a body', () => {
    const ctx = mockRes();
    sendDocsHtml({ method: 'HEAD' }, ctx.res, swaggerUiHtml());
    expect(ctx.statusCode).toBe(200);
    expect(ctx.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(ctx.body).toBeUndefined();
  });

  it('OPTIONS is 200 and POST is 405', () => {
    const options = mockRes();
    sendDocsHtml({ method: 'OPTIONS' }, options.res, swaggerUiHtml());
    expect(options.statusCode).toBe(200);
    expect(options.body).toBeUndefined();

    const post = mockRes();
    sendDocsHtml({ method: 'POST' }, post.res, swaggerUiHtml());
    expect(post.statusCode).toBe(405);
    expect(post.body).toEqual({ error: 'Method not allowed' });
    expect(post.headers.Allow).toBe('GET, HEAD, OPTIONS');
  });
});

describe('docs / redoc handlers', () => {
  it('GET /docs is Swagger UI over /openapi.json', () => {
    const ctx = mockRes();
    docsHandler({ method: 'GET' } as never, ctx.res as never);
    expect(ctx.statusCode).toBe(200);
    expect(String(ctx.body)).toContain('swagger-ui');
    expect(String(ctx.body)).toContain('/openapi.json');
  });

  it('GET /redoc is ReDoc over /openapi.json', () => {
    const ctx = mockRes();
    redocHandler({ method: 'GET' } as never, ctx.res as never);
    expect(ctx.statusCode).toBe(200);
    expect(String(ctx.body)).toContain('redoc');
    expect(String(ctx.body)).toContain('/openapi.json');
  });
});

describe('vercel rewrites for docs viewers', () => {
  it('maps /docs and /redoc to the API handlers without touching verify', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      rewrites: { source: string; destination: string }[];
    };
    expect(vercel.rewrites).toEqual(
      expect.arrayContaining([
        { source: '/openapi.json', destination: '/api/openapi' },
        { source: '/docs', destination: '/api/docs' },
        { source: '/docs/', destination: '/api/docs' },
        { source: '/redoc', destination: '/api/redoc' },
        { source: '/redoc/', destination: '/api/redoc' },
        { source: '/sentinel/(.*)', destination: '/api/sentinel/$1' },
      ]),
    );
    expect(vercel.rewrites.some((row) => row.source.includes('/sentinel/verify'))).toBe(false);
  });
});
