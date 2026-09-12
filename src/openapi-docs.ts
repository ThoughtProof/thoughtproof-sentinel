/**
 * Lightweight published OpenAPI viewers (Swagger UI + ReDoc).
 * Served at /docs and /redoc; both load the live /openapi.json.
 *
 * CDN scripts are exact-version pins with sha384 SRI (computed 2026-09-12
 * from the bytes unpkg served for these versions). Do not float majors.
 * Users may paste X-Sentinel-Key into Swagger Try-it-out.
 */

export const OPENAPI_SPEC_URL = '/openapi.json';

/** Exact unpkg pins — no bare @5 / @2. */
export const SWAGGER_UI_DIST_VERSION = '5.32.15';
export const REDOC_VERSION = '2.5.4';

export const DOCS_CDN = {
  swaggerCss: {
    href: `https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_DIST_VERSION}/swagger-ui.css`,
    integrity: 'sha384-fgyWYkUAamzuI8mJFu/xpRP0JWCJRwkwUwsYDoOYVHUJ8NQE5cENn8ib3ppwFFSX',
  },
  swaggerBundle: {
    href: `https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_DIST_VERSION}/swagger-ui-bundle.js`,
    integrity: 'sha384-m7zaGj7MPzU+G4lz2eyy73GxK9bbRDr9bB2CSdj8wodg2wu/Wnt6wsoLP3JD+RS9',
  },
  redoc: {
    href: `https://unpkg.com/redoc@${REDOC_VERSION}/bundles/redoc.standalone.js`,
    integrity: 'sha384-w447zOpYfw/1Tv/5AK9NfHTlQIqE3RVR6KY62jCyy9zNDgO64cMwGGP1Fj0zJVf5',
  },
} as const;

/** script/style: self + pinned unpkg host; connect stays same-origin (Try-it-out). */
export const DOCS_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://unpkg.com",
  "style-src 'unsafe-inline' https://unpkg.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export type DocsLikeRequest = { method?: string };

export type DocsLikeResponse = {
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => {
    end: (body?: string) => unknown;
    json: (body: unknown) => unknown;
  };
};

function sriAttrs(href: string, integrity: string): string {
  return `href="${href}" integrity="${integrity}" crossorigin="anonymous"`;
}

function sriScript(src: string, integrity: string): string {
  return `<script src="${src}" integrity="${integrity}" crossorigin="anonymous"></script>`;
}

export function swaggerUiHtml(specUrl = OPENAPI_SPEC_URL): string {
  const spec = escapeHtmlAttr(specUrl);
  const css = DOCS_CDN.swaggerCss;
  const js = DOCS_CDN.swaggerBundle;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ThoughtProof Sentinel API — Docs</title>
  <link rel="stylesheet" ${sriAttrs(css.href, css.integrity)} />
</head>
<body>
  <noscript><a href="${spec}">OpenAPI document</a></noscript>
  <div id="swagger-ui"></div>
  ${sriScript(js.href, js.integrity)}
  <script>
    window.ui = SwaggerUIBundle({
      url: ${JSON.stringify(specUrl)},
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>
`;
}

export function redocHtml(specUrl = OPENAPI_SPEC_URL): string {
  const spec = escapeHtmlAttr(specUrl);
  const js = DOCS_CDN.redoc;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ThoughtProof Sentinel API — ReDoc</title>
  <style>body{margin:0;padding:0}</style>
</head>
<body>
  <noscript><a href="${spec}">OpenAPI document</a></noscript>
  <redoc spec-url="${spec}"></redoc>
  ${sriScript(js.href, js.integrity)}
</body>
</html>
`;
}

export function sendDocsHtml(
  req: DocsLikeRequest,
  res: DocsLikeResponse,
  html: string,
): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sentinel-Key');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Security-Policy', DOCS_CSP);

  const method = (req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).end(method === 'HEAD' ? undefined : html);
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
