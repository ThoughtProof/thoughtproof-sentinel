/**
 * Published /docs + /redoc viewers over live /openapi.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import docsHandler from '../api/docs.js';
import redocHandler from '../api/redoc.js';
import {
  DOCS_CDN,
  DOCS_CSP,
  OPENAPI_SPEC_URL,
  REDOC_VERSION,
  SWAGGER_UI_DIST_VERSION,
  redocHtml,
  sendDocsHtml,
  swaggerUiHtml,
} from './openapi-docs.js';
import {
  REQUIRED_DOCS_CDN_ASSETS,
  assertRequiredDocsCdnAssets,
  checkDocsCdnAsset,
  docsCdnAssets,
  docsCdnSriJobExitCode,
  formatAssetFailure,
  isSriHashMismatch,
  sriSha384,
  verifyDocsCdnSri,
} from '../scripts/verify-docs-cdn-sri.ts';

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

  it('pins exact CDN versions with sha384 SRI (no floating majors)', () => {
    const swagger = swaggerUiHtml();
    const redoc = redocHtml();
    expect(SWAGGER_UI_DIST_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(REDOC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(swagger).toContain(`swagger-ui-dist@${SWAGGER_UI_DIST_VERSION}/`);
    expect(redoc).toContain(`redoc@${REDOC_VERSION}/`);
    expect(swagger).not.toContain('swagger-ui-dist@5/');
    expect(redoc).not.toContain('redoc@2/');
    expect(swagger).toContain('integrity="sha384-');
    expect(redoc).toContain('integrity="sha384-');
    for (const asset of Object.values(DOCS_CDN)) {
      expect(asset.integrity).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/);
      expect(asset.href).toContain('unpkg.com');
    }
    expect(swagger).toContain(`integrity="${DOCS_CDN.swaggerCss.integrity}"`);
    expect(swagger).toContain(`integrity="${DOCS_CDN.swaggerBundle.integrity}"`);
    expect(redoc).toContain(`integrity="${DOCS_CDN.redoc.integrity}"`);
    expect(swagger.match(/crossorigin="anonymous"/g)?.length).toBe(2);
    expect(redoc.match(/crossorigin="anonymous"/g)?.length).toBe(1);
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
    expect(ctx.headers['Content-Security-Policy']).toBe(DOCS_CSP);
    expect(ctx.headers['Content-Security-Policy']).toContain("script-src 'unsafe-inline' https://unpkg.com");
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

describe('docs CDN SRI byte check (nightly, no live unpkg)', () => {
  it('imports the same three DOCS_CDN pins used in HTML', () => {
    const assets = docsCdnAssets();
    expect(assets.map((row) => row.name)).toEqual([...REQUIRED_DOCS_CDN_ASSETS]);
    expect(assets).toEqual([
      { name: 'swaggerCss', href: DOCS_CDN.swaggerCss.href, integrity: DOCS_CDN.swaggerCss.integrity },
      { name: 'swaggerBundle', href: DOCS_CDN.swaggerBundle.href, integrity: DOCS_CDN.swaggerBundle.integrity },
      { name: 'redoc', href: DOCS_CDN.redoc.href, integrity: DOCS_CDN.redoc.integrity },
    ]);
    assertRequiredDocsCdnAssets(assets);
    expect(() => assertRequiredDocsCdnAssets(assets.slice(0, 2))).toThrow(/missing required assets/);
  });

  it('formats sha384 SRI; mismatch hard-fails, fetch/non-200 soft-fails', async () => {
    const bytes = new TextEncoder().encode('docs-cdn-sri-fixture');
    const integrity = sriSha384(bytes);
    expect(integrity).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/);

    const href = 'https://unpkg.com/swagger-ui-dist@9.9.9/swagger-ui.css';
    const asset = { name: 'swaggerCss', href, integrity };

    const okFetch = async () =>
      new Response(bytes, { status: 200 }) as Response;
    const ok = await checkDocsCdnAsset(asset, okFetch);
    expect(ok).toMatchObject({ ok: true, name: 'swaggerCss', integrity });
    expect(docsCdnSriJobExitCode([ok])).toBe(0);

    const mismatch = await checkDocsCdnAsset(asset, async () =>
      new Response(new TextEncoder().encode('tampered'), { status: 200 }),
    );
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error('expected mismatch');
    expect(isSriHashMismatch(mismatch)).toBe(true);
    expect(mismatch.expected).toBe(integrity);
    expect(mismatch.actual).toMatch(/^sha384-/);
    expect(mismatch.actual).not.toBe(integrity);
    const mismatchText = formatAssetFailure(mismatch);
    expect(mismatchText).toContain('DOCS_CDN.swaggerCss FAILED');
    expect(mismatchText).toContain(href);
    expect(mismatchText).toContain(`expected: ${integrity}`);
    expect(mismatchText).toContain(`actual:   ${mismatch.actual}`);
    expect(docsCdnSriJobExitCode([mismatch])).toBe(1);

    const missing = await checkDocsCdnAsset(asset, async () =>
      new Response('gone', { status: 404 }),
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected 404');
    expect(isSriHashMismatch(missing)).toBe(false);
    expect(missing.status).toBe(404);
    expect(missing.actual).toBeNull();
    expect(formatAssetFailure(missing)).toContain('HTTP 404');
    expect(docsCdnSriJobExitCode([missing])).toBe(0);

    const offline = await checkDocsCdnAsset(asset, async () => {
      throw new Error('ECONNRESET');
    });
    expect(offline.ok).toBe(false);
    if (offline.ok) throw new Error('expected fetch failure');
    expect(isSriHashMismatch(offline)).toBe(false);
    expect(offline.status).toBeNull();
    expect(offline.error).toContain('ECONNRESET');
    expect(docsCdnSriJobExitCode([offline])).toBe(0);

    const networkBatch = await verifyDocsCdnSri(
      [
        asset,
        { name: 'swaggerBundle', href: `${href}-bundle`, integrity },
        { name: 'redoc', href: `${href}-redoc`, integrity },
      ],
      async (url) => {
        if (String(url).endsWith('-redoc')) return new Response('nope', { status: 503 });
        return new Response(bytes, { status: 200 });
      },
    );
    expect(networkBatch.ok).toBe(false);
    expect(networkBatch.results.filter((row) => row.ok)).toHaveLength(2);
    const failed = networkBatch.results.find((row) => !row.ok);
    expect(failed && !failed.ok && failed.status).toBe(503);
    expect(docsCdnSriJobExitCode(networkBatch.results)).toBe(0);

    const mixed = [ok, missing, mismatch];
    expect(docsCdnSriJobExitCode(mixed)).toBe(1);
  });

  it('nightly workflow runs the SRI check off PR CI only', () => {
    const yml = readFileSync(join(process.cwd(), '.github/workflows/action-authorization-suite.yml'), 'utf8');
    expect(yml).toContain('docs-cdn-sri:');
    expect(yml).toContain('scripts/verify-docs-cdn-sri.ts');
    expect(yml).toContain("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
    expect(yml).toContain('Verify unpkg SRI matches DOCS_CDN');
    expect(yml).toContain('count the suite job result, not the whole workflow');
    expect(yml).toContain('FALSE_BLOCK_BASELINE');
    expect(yml).not.toMatch(/FALSE_BLOCK_BASELINE\s*=\s*[12356789]/);
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
