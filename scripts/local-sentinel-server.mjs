/**
 * Localhost-only Sentinel for the pot-cli pre-publish check.
 *
 * Binds 127.0.0.1. Serves GET /sentinel/health and POST /sentinel/verify.
 * Does not call Vercel and does not accept a public bind address.
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     --import ./scripts/register-ts.mjs scripts/local-sentinel-server.mjs
 *
 * LOCAL_SENTINEL_PORT       default 3001
 * LOCAL_SENTINEL_LOG_DIR    if set, write health/responses/summary there
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOST = '127.0.0.1';
const port = Number(process.env.LOCAL_SENTINEL_PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('local-sentinel: LOCAL_SENTINEL_PORT must be an integer 1-65535');
  process.exit(1);
}

const logDir = process.env.LOCAL_SENTINEL_LOG_DIR || '';
if (logDir) mkdirSync(join(logDir, 'responses'), { recursive: true });

const { default: healthHandler } = await import('../api/sentinel/health.ts');
const { default: verifyHandler } = await import('../api/sentinel/verify.ts');

const cases = [];

function safeId(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'request';
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function scanMarkers(text) {
  return {
    provenance_downgrade: text.includes('PROVENANCE DOWNGRADE'),
    prov_fail_01: text.includes('PROV_FAIL_01'),
  };
}

function writeSummary() {
  if (!logDir) return;
  const price = cases.reduce((sum, row) => sum + (Number(row.price_usd) || 0), 0);
  writeFileSync(
    join(logDir, 'responses-summary.json'),
    `${JSON.stringify({
      host: HOST,
      port,
      cases: cases.length,
      price_usd_sum: Number(price.toFixed(4)),
      provenance_downgrade: cases.filter((row) => row.provenance_downgrade).map((row) => row.id),
      prov_fail_01: cases.filter((row) => row.prov_fail_01).map((row) => row.id),
      rows: cases,
    }, null, 2)}\n`,
  );
}

function adapter(nodeReq, nodeRes, body) {
  let statusCode = 200;
  const res = {
    setHeader(key, value) {
      nodeRes.setHeader(key, value);
      return this;
    },
    getHeader(key) {
      return nodeRes.getHeader(key);
    },
    status(code) {
      statusCode = code;
      nodeRes.statusCode = code;
      return this;
    },
    json(data) {
      nodeRes.statusCode = statusCode;
      if (!nodeRes.getHeader('content-type')) {
        nodeRes.setHeader('content-type', 'application/json; charset=utf-8');
      }
      nodeRes.end(JSON.stringify(data));
      return this;
    },
    end(chunk) {
      nodeRes.statusCode = statusCode;
      nodeRes.end(chunk);
      return this;
    },
    send(chunk) {
      return this.end(chunk);
    },
  };
  const req = {
    method: nodeReq.method,
    url: nodeReq.url,
    headers: nodeReq.headers,
    body,
    query: {},
    socket: nodeReq.socket,
  };
  return { req, res };
}

function readBody(nodeReq) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    nodeReq.on('data', (chunk) => chunks.push(chunk));
    nodeReq.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
    nodeReq.on('error', reject);
  });
}

const server = createServer(async (nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url || '/', `http://${HOST}`);
  const path = url.pathname.replace(/\/$/, '') || '/';
  try {
    const body = nodeReq.method === 'GET' || nodeReq.method === 'HEAD' ? undefined : await readBody(nodeReq);
    const { req, res } = adapter(nodeReq, nodeRes, body);
    if (path === '/sentinel/health' && (nodeReq.method === 'GET' || nodeReq.method === 'OPTIONS')) {
      await healthHandler(req, res);
      return;
    }
    if (path === '/sentinel/verify' && (nodeReq.method === 'POST' || nodeReq.method === 'OPTIONS')) {
      const id = safeId(body && typeof body === 'object' ? body.agent_context?.external_request_id : undefined);
      const started = Date.now();
      let captured = null;
      const originalJson = res.json.bind(res);
      res.json = (data) => {
        captured = data;
        return originalJson(data);
      };
      await verifyHandler(req, res);
      if (logDir && captured && typeof captured === 'object') {
        const text = JSON.stringify(captured);
        const flags = scanMarkers(text);
        const row = {
          id,
          http_status: nodeRes.statusCode,
          verdict: captured.verdict ?? null,
          receipt_id: captured.id ?? null,
          promotion: captured.meta?.promotion?.reason ?? null,
          price_usd: captured.billing?.price_usd ?? null,
          elapsed_ms: Date.now() - started,
          ...flags,
        };
        cases.push(row);
        writeFileSync(join(logDir, 'responses', `${id}.json`), `${text}\n`);
        writeSummary();
        console.log(
          `verify id=${id} http=${row.http_status} verdict=${row.verdict ?? '—'} ` +
            `promotion=${row.promotion ?? '—'} provenance_downgrade=${flags.provenance_downgrade} ` +
            `prov_fail_01=${flags.prov_fail_01} elapsed_ms=${row.elapsed_ms}`,
        );
      }
      return;
    }
    nodeRes.statusCode = 404;
    nodeRes.setHeader('content-type', 'application/json; charset=utf-8');
    nodeRes.end(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }));
  } catch (err) {
    console.error('local-sentinel request error:', err instanceof Error ? err.message : 'error');
    if (!nodeRes.headersSent) {
      nodeRes.statusCode = 500;
      nodeRes.setHeader('content-type', 'application/json; charset=utf-8');
      nodeRes.end(JSON.stringify({ error: 'Internal server error', code: 'INTERNAL_ERROR' }));
    }
  }
});

server.listen(port, HOST, () => {
  console.log(`local-sentinel listening http://${HOST}:${port}`);
});
