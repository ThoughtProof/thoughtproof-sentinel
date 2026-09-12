/**
 * Lightweight published OpenAPI viewers (Swagger UI + ReDoc).
 * Served at /docs and /redoc; both load the live /openapi.json.
 */

export const OPENAPI_SPEC_URL = '/openapi.json';

export type DocsLikeRequest = { method?: string };

export type DocsLikeResponse = {
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => {
    end: (body?: string) => unknown;
    json: (body: unknown) => unknown;
  };
};

export function swaggerUiHtml(specUrl = OPENAPI_SPEC_URL): string {
  const spec = escapeHtmlAttr(specUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ThoughtProof Sentinel API — Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" crossorigin />
</head>
<body>
  <noscript><a href="${spec}">OpenAPI document</a></noscript>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
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
  <script src="https://unpkg.com/redoc@2/bundles/redoc.standalone.js" crossorigin></script>
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
