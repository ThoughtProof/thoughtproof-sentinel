import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer, request, type Server} from 'node:http';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

// Only provider completions are replaced. The HTTP handler, validation, engine,
// installed evaluator, auth and signed-evidence processing are real. No keys,
// payments, attestations or external services are used by this loopback test.
vi.hoisted(() => {
  process.env.SERV_API_KEY = 'offline-fixture-only';
  process.env.SERV_BASE_URL = 'https://offline.invalid/v1';
});
import handler from '../api/sentinel/verify.js';
import {verify} from './engine/index.js';
import {validateVerifyRequest} from './validation.js';
import {computePackageDigest} from './package-digest.js';
import type {TradeRiskInput} from './engine/trade-risk-gate.js';
import type {SentinelVerifyRequest, SentinelVerifyResponse} from './types.js';

const positive: SentinelVerifyRequest = JSON.parse(readFileSync(new URL(
  './engine/fixtures/cycle-quotes-20261017/supported_control_request.json', import.meta.url), 'utf8'));
const risk: TradeRiskInput = {policy: 'cycle-risk-v1', side: 'long', entry: 2000,
  stop: 1900, size_pct: .1, risk_pct: .01, leverage: 2, macro_size_mult: .5};
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const quotes = positive.evidence.split('\n').filter(line => /^Pre-decision reasoning [123]:/.test(line));
const rows = (score = 1) => quotes.map((quote, i) => ({step_id: `step_${i}`, score, quote,
  reasoning: 'Synthetic controlled completion; the supplied facts support this criterion.'}));
const body = (evidence = positive.evidence): SentinelVerifyRequest => ({
  ...positive, tier: 'checkpoint', evidence, trade_risk: {...risk},
});

let server: Server;
let port: number;
let completion: unknown;
let providerCalls: string[];

beforeAll(async () => {
  server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const req = Object.assign(incoming, {
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')), query: {},
      });
      const res = Object.assign(outgoing, {
        status(code: number) { outgoing.statusCode = code; return res; },
        json(value: unknown) {
          outgoing.setHeader('Content-Type', 'application/json');
          outgoing.end(JSON.stringify(value));
          return res;
        },
      });
      await handler(req as never, res as never);
    } catch {
      outgoing.statusCode = 500;
      outgoing.end(JSON.stringify({error: 'loopback adapter failed'}));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback TCP address');
  port = address.port;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

beforeEach(() => {
  providerCalls = [];
  completion = rows();
  vi.stubEnv('SENTINEL_AUTH_REQUIRED', 'true');
  vi.stubEnv('SENTINEL_API_KEYS', 'offline-http-contract:direct');
  vi.stubEnv('SENTINEL_X402_ENABLED', 'false');
  vi.stubEnv('SENTINEL_TRADE_CHECKPOINT_MODEL', 'serv-nano');
  vi.stubEnv('CONFIRM_BLOCKS', '0');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined);
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined);
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_METER_EVENT_NAME', 'STRIPE_CUSTOMER_MAP',
    'ATTESTER_PRIVATE_KEY', 'SENTINEL_EXPORT_PRIVATE_KEY']) vi.stubEnv(key, '');
  vi.stubEnv('SHADOW_ADR0020', 'off');
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    expect(String(url)).toBe('https://offline.invalid/v1/chat/completions');
    providerCalls.push(String(init?.body));
    return new Response(JSON.stringify({choices: [{message: {content: JSON.stringify(completion)}}]}));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function post(payload: unknown, key = 'offline-http-contract') {
  return new Promise<{status: number; data: SentinelVerifyResponse & {code?: string}}>((resolve, reject) => {
    const req = request({hostname: '127.0.0.1', port, path: '/sentinel/verify', method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Sentinel-Key': key}}, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        try { resolve({status: res.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString('utf8'))}); }
        catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}

describe('trade-risk evidence contract across native and loopback HTTP entry points', () => {
  it.each([
    ['unchanged', '', ''],
    ['leading LF', '\n', ''],
    ['trailing LF', '', '\n'],
    ['space/tab/CRLF', ' \t\r\n', '\r\n\t '],
    ['ECMAScript Unicode whitespace', '\ufeff\u00a0\u2003', '\u2028\u2029'],
  ])('uses HTTP trim semantics for %s, including a positive ALLOW', async (_name, prefix, suffix) => {
    const input = body(prefix + positive.evidence + suffix);
    const original = structuredClone(input);
    const validated = validateVerifyRequest(input);
    if (!validated.valid) throw new Error('Synthetic request must validate');
    const http = await post(input);
    const native = await verify(input);
    expect(http.status).toBe(200);
    for (const result of [http.data, native]) {
      expect(result).toMatchObject({id: input.id, mode: input.mode, tier: input.tier, verdict: 'ALLOW'});
      expect(result.meta.trade_risk).toMatchObject({schema_version: 'sentinel.trade-risk-result.v1',
        status: 'pass', checked_input: risk, evidence_sha256: sha256(input.evidence.trim()),
        allowed_risk_pct: .005, codes: []});
      expect(result.meta.trade_risk?.actual_risk_pct).toBeCloseTo(.005, 12);
      expect(result.objections.map(row => row.quote)).toEqual(quotes);
    }
    expect(computePackageDigest(validated.data)).toBe(computePackageDigest({
      ...validated.data, evidence: positive.evidence,
    }));
    expect(providerCalls).toHaveLength(2);
    // Receipt identity must describe the text actually supplied to the evaluator.
    expect(providerCalls[0]).toBe(providerCalls[1]);
    expect(input).toEqual(original);
  });

  it.each([
    ['LF versus CRLF', '\n', '\r\n'],
    ['newline versus literal escape', '\n', '\\n'],
    ['internal spacing', 'a b', 'a  b'],
    ['Unicode composition', '\u00e9', 'e\u0301'],
    ['zero-width space', '', '\u200b'],
    ['non-ECMAScript whitespace', '', '\u0085'],
  ])('keeps distinct evidence bound for %s', async (_name, first, second) => {
    const inputs = [first, second].map(marker => body(`\n${positive.evidence}\nINTERNAL:${marker}:END\n`));
    const outputs = [];
    const digests: string[] = [];
    for (const input of inputs) {
      const validated = validateVerifyRequest(input);
      if (!validated.valid) throw new Error('Synthetic request must validate');
      digests.push(computePackageDigest(validated.data));
      const result = await post(input);
      expect(result.status).toBe(200);
      expect(result.data.verdict).toBe('ALLOW');
      expect(result.data.meta.trade_risk?.evidence_sha256).toBe(sha256(input.evidence.trim()));
      outputs.push(result.data);
    }
    expect(outputs[0].meta.trade_risk?.evidence_sha256).not.toBe(outputs[1].meta.trade_risk?.evidence_sha256);
    expect(digests[0]).not.toBe(digests[1]);
  });

  it.each([
    [{stop: 1800}, 'stop_risk_exceeds_budget'],
    [{leverage: 2.01}, 'leverage_limit'],
    [{stop: 2000}, 'stop_direction'],
    [{macro_size_mult: 0}, 'macro_halt'],
  ] as Array<[Partial<TradeRiskInput>, string]>)('keeps %j blocked before inference in shadow mode', async (change, code) => {
    const input = {...body('\n' + positive.evidence + '\n'), trade_risk: {...risk, ...change}, gateMode: 'shadow' as const};
    const http = await post(input);
    const native = await verify(input);
    expect(http.status).toBe(200);
    for (const result of [http.data, native]) {
      expect(result.verdict).toBe('BLOCK');
      expect(result.meta.models_used).toEqual([]);
      expect(result.meta.trade_risk?.codes).toContain(code);
      expect(result.meta.trade_risk?.evidence_sha256).toBe(sha256(input.evidence.trim()));
    }
    expect(providerCalls).toHaveLength(0);
  });

  it('preserves the duplicate-order check with padded JSON evidence', async () => {
    const evidence = '\r\n' + JSON.stringify({trade_plan: {...risk, stop: 1800, macro: {size_mult: .5}}}) + '\n';
    const result = await post(body(evidence));
    expect(result.status).toBe(200);
    expect(result.data.verdict).toBe('BLOCK');
    expect(result.data.meta.trade_risk?.codes).toContain('evidence_order_mismatch');
    expect(providerCalls).toHaveLength(0);
  });

  it.each([
    {evidence: ' \t\r\n\u00a0'},
    {evidence: 42},
    {evidence: '\n' + 'x'.repeat(500_000)},
    {trade_risk: {...risk, leverage: '2'}},
    {trade_risk: {...risk, max_risk_pct: .5}},
    {unexpected_field: true},
  ])('retains HTTP validation for malformed, oversized or unbound inputs %#', async change => {
    const result = await post({...body(), ...change});
    expect(result.status).toBe(400);
    expect(result.data.code).toBe('INVALID_REQUEST');
    expect(providerCalls).toHaveLength(0);
  });

  it('retains authentication before the engine', async () => {
    const result = await post(body(), 'wrong-key');
    expect(result.status).toBe(401);
    expect(result.data.code).toBe('UNAUTHORIZED');
    expect(providerCalls).toHaveLength(0);
  });

  it('retains signed-evidence BLOCK and binds the exact validated package after a model ALLOW', async () => {
    const forged: SentinelVerifyRequest = JSON.parse(readFileSync(new URL(
      '../scripts/fixtures/f5/request-forged.json', import.meta.url), 'utf8'));
    const input = {...body('\n' + positive.evidence + '\n'), signed_evidence: forged.signed_evidence};
    const validated = validateVerifyRequest(input);
    if (!validated.valid) throw new Error('Synthetic request must validate');
    const result = await post(input);
    expect(result.status).toBe(200);
    expect(result.data.verdict).toBe('BLOCK');
    expect(result.data.meta.trade_risk?.status).toBe('pass');
    expect(result.data.meta.trade_risk?.evidence_sha256).toBe(sha256(input.evidence.trim()));
    expect(result.data.meta.package_digest).toBe(computePackageDigest(validated.data));
    expect(result.data.meta.evidence_verification?.[0].code).toBe('evidence_signature_invalid');
    expect(providerCalls).toHaveLength(1);
  });

  it.each([
    [[], 'UNCERTAIN'],
    [rows(0), 'BLOCK'],
  ])('never promotes a restrictive model result after a matching risk pass %#', async (output, verdict) => {
    completion = output;
    const input = body('\n' + positive.evidence + '\n');
    const result = await post(input);
    expect(result.status).toBe(200);
    expect(result.data.verdict).toBe(verdict);
    expect(result.data.meta.trade_risk?.status).toBe('pass');
    expect(result.data.meta.trade_risk?.evidence_sha256).toBe(sha256(input.evidence.trim()));
  });
});
