/**
 * Handler wiring for ADR-0023 stage 4. Engine, billing, and the payment
 * gate are mocked. No provider keys and no network.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const engineState = vi.hoisted(() => ({
  verdict: 'UNCERTAIN' as 'ALLOW' | 'BLOCK' | 'UNCERTAIN',
}));

vi.mock('./engine/index.js', () => ({
  verify: vi.fn(async () => {
    calls.push('engine');
    return {
      id: 'sent_wire_handler',
      verdict: engineState.verdict,
      confidence: 0.4,
      reasoning: 'fixture',
      objections: [],
      mode: 'handoff',
      tier: 'checkpoint',
      meta: {
        duration_ms: 10,
        models_used: ['serv-nano'],
        verified_at: '2026-09-10T00:00:00.000Z',
      },
    };
  }),
}));

vi.mock('./billing.js', () => ({
  buildBillingEvent: vi.fn(() => ({
    price_usd: 0.005,
    platform: 'direct',
  })),
  recordBillingEvent: vi.fn(async () => {
    calls.push('billing');
  }),
}));

vi.mock('./middleware/x402.js', () => ({
  x402Gate: vi.fn(async () => {
    calls.push('x402');
    return { allowed: true, paymentMethod: 'api-key' };
  }),
}));

import handler from '../api/sentinel/verify.js';
import { verify } from './engine/index.js';
import { x402Gate } from './middleware/x402.js';
import { recordBillingEvent } from './billing.js';
import {
  MANDATE_REQUEST_DEPS,
  type MandateRequestDeps,
} from './mandate-request-path.js';
import { MANDATE_VERIFICATION_UNAVAILABLE_MESSAGE } from './mandate-no-auth.js';
import { normalizeMandate } from './mandate-normalize.js';
import {
  PRINCIPAL_MANDATE_PURPOSE,
  PRINCIPAL_MANDATE_SCHEMA,
  principalMandateSignedBytes,
  type PrincipalManifestStore,
  type PrincipalProofFields,
  type PrincipalPublicKey,
} from './principal-key-manifest.js';
import type { MandateReplayCommand } from './mandate-replay-store.js';

const verifyMock = vi.mocked(verify);
const x402Mock = vi.mocked(x402Gate);
const billingMock = vi.mocked(recordBillingEvent);

const SECRET = 'sk_test_DO_NOT_LEAK_sentinel_32';
const API_KEY = 'wire-handler-key';
const ACCOUNT = 'acct-handler';
const KID = 'kid-handler';
const NOW = 1_800_000_000;

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'SERV_API_KEY',
  'SENTINEL_AUTH_REQUIRED',
  'SENTINEL_MANDATE_PROOF_ENFORCE',
  'SENTINEL_API_KEYS',
  'SENTINEL_X402_ENABLED',
  'SENTINEL_EXPORT_PRIVATE_KEY',
] as const;

const primary = generateKeyPairSync('ed25519');

function okpX(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

const PRIMARY_X = okpX(primary.publicKey);

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function keyEntry(over: Partial<PrincipalPublicKey> = {}): PrincipalPublicKey {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    x: PRIMARY_X,
    kid: KID,
    status: 'active',
    notBefore: iso(NOW - 1000),
    notAfter: iso(NOW + 1000),
    ...over,
  };
}

const TRANSFER = {
  kind: 'value_transfer',
  granted: { maxAmount: 1, asset: 'USDC', recipient: 'payee-handler' },
  action: { kind: 'value_transfer', amount: 1, asset: 'USDC', recipient: 'payee-handler' },
};

function proofFields(over: Partial<PrincipalProofFields> = {}): PrincipalProofFields {
  return {
    schema_version: PRINCIPAL_MANDATE_SCHEMA,
    nonce: 'nonce-handler-1',
    iat: NOW,
    exp: NOW + 60,
    account_id: ACCOUNT,
    environment: 'production',
    purpose: PRINCIPAL_MANDATE_PURPOSE,
    principal_kid: KID,
    ...over,
  };
}

function signedProof(mandate: unknown, over: Partial<PrincipalProofFields> = {}) {
  const proof = proofFields(over);
  const bytes = principalMandateSignedBytes(mandate, proof);
  if (!bytes) throw new Error('fixture bytes were not produced');
  return { ...proof, signature: sign(null, bytes, primary.privateKey).toString('hex') };
}

function handlerDeps(over: Partial<MandateRequestDeps> = {}): MandateRequestDeps {
  const store: PrincipalManifestStore = {
    async load() {
      return {
        answered: true,
        manifest: { accountId: ACCOUNT, keys: [keyEntry()] },
      };
    },
  };
  const replay: MandateReplayCommand = {
    async eval() {
      calls.push('consume');
      return `consumed:${NOW + 60 + 30 + 1}`;
    },
    async pttl() {
      return 1;
    },
  };
  return {
    nowSeconds: () => NOW,
    readPolicy: () => 'protected',
    manifestStore: store,
    replayCommand: replay,
    targetEnvironment: 'production',
    env: { SENTINEL_API_KEYS: `${API_KEY}:direct:agent-h:${ACCOUNT}` },
    ...over,
  };
}

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

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    query: {},
  };
  return req;
}

function attachDeps(req: object, deps: MandateRequestDeps): void {
  (req as unknown as { [MANDATE_REQUEST_DEPS]: MandateRequestDeps })[MANDATE_REQUEST_DEPS] = deps;
}

function baseBody(extra: Record<string, unknown> = {}) {
  return {
    claim: 'Delegate refund processing to payment-agent-v2',
    evidence: 'Order #4521 refund $45 within 30-day policy. Item received.',
    mode: 'handoff',
    tier: 'checkpoint',
    ...extra,
  };
}

describe('POST /sentinel/verify mandate proof flag', () => {
  beforeEach(() => {
    calls.length = 0;
    engineState.verdict = 'UNCERTAIN';
    verifyMock.mockClear();
    x402Mock.mockClear();
    billingMock.mockClear();
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.SERV_API_KEY = SECRET;
    delete process.env.SENTINEL_AUTH_REQUIRED;
    delete process.env.SENTINEL_MANDATE_PROOF_ENFORCE;
    delete process.env.SENTINEL_API_KEYS;
    delete process.env.SENTINEL_X402_ENABLED;
    delete process.env.SENTINEL_EXPORT_PRIVATE_KEY;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('keeps the response byte-identical while the flag is off', async () => {
    const seen: string[] = [];
    for (const flag of [undefined, 'false', '0', 'TRUE', 'yes', '']) {
      if (flag === undefined) delete process.env.SENTINEL_MANDATE_PROOF_ENFORCE;
      else process.env.SENTINEL_MANDATE_PROOF_ENFORCE = flag;
      const ctx = mockRes();
      await handler(
        request(baseBody(), { 'x-sentinel-key': 'wire-flag-off' }) as never,
        ctx.res as never,
      );
      expect(ctx.statusCode).toBe(200);
      const body = ctx.body as { verdict: string; meta: Record<string, unknown> };
      expect(body.verdict).toBe('UNCERTAIN');
      expect(body).not.toHaveProperty('mandate_source');
      expect(body).not.toHaveProperty('mandateSource');
      expect(JSON.stringify(body)).not.toContain('principal_signed');
      expect(JSON.stringify(body)).not.toContain(SECRET);
      seen.push(JSON.stringify(body));
    }
    expect(new Set(seen).size).toBe(1);
    expect(verifyMock).toHaveBeenCalledTimes(6);
    expect(x402Mock).toHaveBeenCalledTimes(6);

    verifyMock.mockClear();
    x402Mock.mockClear();
    const rejected = mockRes();
    await handler(
      request(baseBody({ mandate_proof: { signature: 'ab' } }), {
        'x-sentinel-key': 'wire-flag-off-unknown',
      }) as never,
      rejected.res as never,
    );
    expect(rejected.statusCode).toBe(400);
    expect(JSON.stringify(rejected.body)).toContain('mandate_proof');
    expect(verifyMock).not.toHaveBeenCalled();
    expect(x402Mock).toHaveBeenCalledOnce();
  });

  it('returns 401 for an invalid key before any mandate decision', async () => {
    process.env.SENTINEL_MANDATE_PROOF_ENFORCE = 'true';
    process.env.SENTINEL_AUTH_REQUIRED = 'true';
    process.env.SENTINEL_API_KEYS = `${API_KEY}:direct:agent-h:${ACCOUNT}`;
    const ctx = mockRes();
    await handler(
      request(baseBody({ mandate_proof: { signature: 'aa' } }), {
        'x-sentinel-key': 'wire-invalid-key',
      }) as never,
      ctx.res as never,
    );
    expect(ctx.statusCode).toBe(401);
    expect(ctx.body).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(ctx.body).not.toHaveProperty('verdict');
    expect(JSON.stringify(ctx.body)).not.toContain('ALLOW');
    expect(JSON.stringify(ctx.body)).not.toContain('wire-invalid-key');
    expect(verifyMock).not.toHaveBeenCalled();
    expect(x402Mock).not.toHaveBeenCalled();
    expect(billingMock).not.toHaveBeenCalled();
  });

  it('returns 503 ACCOUNT_UNAVAILABLE for no-auth mode and a pre-account key', async () => {
    process.env.SENTINEL_MANDATE_PROOF_ENFORCE = 'true';
    delete process.env.SENTINEL_AUTH_REQUIRED;
    process.env.SENTINEL_API_KEYS = `${API_KEY}:direct:agent-h:${ACCOUNT}`;
    const open = mockRes();
    await handler(
      request(baseBody(), { 'x-sentinel-key': API_KEY }) as never,
      open.res as never,
    );
    expect(open.statusCode).toBe(503);
    expect(open.body).toEqual({
      error: MANDATE_VERIFICATION_UNAVAILABLE_MESSAGE,
      code: 'ACCOUNT_UNAVAILABLE',
      request_id: open.headers['X-Request-Id'],
    });
    expect(open.body).not.toHaveProperty('verdict');
    expect(verifyMock).not.toHaveBeenCalled();
    expect(x402Mock).not.toHaveBeenCalled();
    expect(billingMock).not.toHaveBeenCalled();

    process.env.SENTINEL_AUTH_REQUIRED = 'true';
    process.env.SENTINEL_API_KEYS = `${API_KEY}:direct:agent-h`;
    const pre = mockRes();
    await handler(
      request(baseBody(), { 'x-sentinel-key': API_KEY }) as never,
      pre.res as never,
    );
    expect(pre.statusCode).toBe(503);
    expect(pre.body).toMatchObject({
      error: MANDATE_VERIFICATION_UNAVAILABLE_MESSAGE,
      code: 'ACCOUNT_UNAVAILABLE',
    });
    expect(pre.body).not.toHaveProperty('verdict');
    expect(JSON.stringify(pre.body)).not.toContain(API_KEY);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('blocks a protected account that omits mandate_proof before side effects', async () => {
    process.env.SENTINEL_MANDATE_PROOF_ENFORCE = 'true';
    process.env.SENTINEL_AUTH_REQUIRED = 'true';
    process.env.SENTINEL_API_KEYS = `${API_KEY}:direct:agent-h:${ACCOUNT}`;
    const req = request(
      baseBody({
        mandate: {
          kind: 'informational',
          action: { kind: 'informational', content: 'status ping secret' },
        },
      }),
      { 'x-sentinel-key': API_KEY },
    );
    attachDeps(req, handlerDeps({
      readPolicy: () => 'protected',
      normalize: () => {
        throw new Error('strict normalizer must not run');
      },
    }));
    const ctx = mockRes();
    await handler(req as never, ctx.res as never);
    expect(ctx.statusCode).toBe(200);
    expect(ctx.body).toMatchObject({
      verdict: 'BLOCK',
      code: 'MANDATE_PROOF_INVALID',
      reason: 'mandate_proof_required',
    });
    expect(JSON.stringify(ctx.body)).not.toContain('status ping secret');
    expect(JSON.stringify(ctx.body)).not.toContain('ALLOW');
    expect(verifyMock).not.toHaveBeenCalled();
    expect(x402Mock).not.toHaveBeenCalled();
    expect(billingMock).not.toHaveBeenCalled();
    expect(calls).not.toContain('consume');
  });

  it('lets a legacy call without a proof reach the existing gates', async () => {
    process.env.SENTINEL_MANDATE_PROOF_ENFORCE = 'true';
    process.env.SENTINEL_AUTH_REQUIRED = 'true';
    process.env.SENTINEL_API_KEYS = `${API_KEY}:direct:agent-h:${ACCOUNT}`;
    engineState.verdict = 'BLOCK';
    const req = request(
      baseBody({
        mandate: {
          kind: 'informational',
          action: { kind: 'informational', content: 'status ping secret' },
        },
      }),
      { 'x-sentinel-key': API_KEY },
    );
    attachDeps(req, handlerDeps({
      readPolicy: () => 'legacy',
      normalize: () => {
        throw new Error('strict normalizer must not run');
      },
    }));
    const ctx = mockRes();
    await handler(req as never, ctx.res as never);
    expect(ctx.statusCode).toBe(200);
    expect((ctx.body as { verdict: string }).verdict).toBe('BLOCK');
    expect(ctx.body).not.toHaveProperty('mandate_source');
    expect(JSON.stringify(ctx.body)).not.toContain('principal_signed');
    expect(verifyMock).toHaveBeenCalledOnce();
    expect(x402Mock).toHaveBeenCalledOnce();
    expect(billingMock).toHaveBeenCalledOnce();
    expect(calls).not.toContain('consume');
  });

  it('keeps the engine verdict when a valid proof is only a precondition', async () => {
    process.env.SENTINEL_MANDATE_PROOF_ENFORCE = 'true';
    process.env.SENTINEL_AUTH_REQUIRED = 'true';
    process.env.SENTINEL_API_KEYS = `${API_KEY}:direct:agent-h:${ACCOUNT}`;
    const normalization = normalizeMandate(TRANSFER);
    expect(normalization.ok).toBe(true);
    if (!normalization.ok) return;
    const proof = signedProof(normalization.mandate);

    for (const verdict of ['ALLOW', 'BLOCK', 'UNCERTAIN'] as const) {
      calls.length = 0;
      engineState.verdict = verdict;
      const req = request(baseBody({ mode: 'action_authorization', mandate: TRANSFER, mandate_proof: proof }), {
        'x-sentinel-key': API_KEY,
      });
      attachDeps(req, handlerDeps());
      const ctx = mockRes();
      await handler(req as never, ctx.res as never);
      expect(ctx.statusCode).toBe(200);
      expect((ctx.body as { verdict: string }).verdict).toBe(verdict);
      expect(ctx.body).not.toHaveProperty('mandate_source');
      expect(JSON.stringify(ctx.body)).not.toContain(proof.signature);
      expect(JSON.stringify(ctx.body)).not.toContain(PRIMARY_X);
      expect(JSON.stringify(ctx.body)).not.toContain(SECRET);
      expect(calls.indexOf('consume')).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf('consume')).toBeLessThan(calls.indexOf('x402'));
      expect(calls.indexOf('x402')).toBeLessThan(calls.indexOf('engine'));
      expect(calls.indexOf('engine')).toBeLessThan(calls.indexOf('billing'));
    }
  });

  it('returns 503 and skips side effects when the replay store is down', async () => {
    process.env.SENTINEL_MANDATE_PROOF_ENFORCE = 'true';
    process.env.SENTINEL_AUTH_REQUIRED = 'true';
    process.env.SENTINEL_API_KEYS = `${API_KEY}:direct:agent-h:${ACCOUNT}`;
    const normalization = normalizeMandate(TRANSFER);
    if (!normalization.ok) throw new Error('fixture mandate did not normalize');
    const proof = signedProof(normalization.mandate, { nonce: 'nonce-handler-down' });
    const req = request(baseBody({ mandate: TRANSFER, mandate_proof: proof }), {
      'x-sentinel-key': API_KEY,
    });
    attachDeps(req, handlerDeps({
      replayCommand: {
        async eval() {
          throw new Error('store token leaked');
        },
        async pttl() {
          return 1;
        },
      },
    }));
    const ctx = mockRes();
    await handler(req as never, ctx.res as never);
    expect(ctx.statusCode).toBe(503);
    expect(ctx.body).toEqual({
      error: MANDATE_VERIFICATION_UNAVAILABLE_MESSAGE,
      code: 'REPLAY_STORE_UNAVAILABLE',
      request_id: ctx.headers['X-Request-Id'],
    });
    expect(ctx.body).not.toHaveProperty('verdict');
    expect(JSON.stringify(ctx.body)).not.toContain('leaked');
    expect(JSON.stringify(ctx.body)).not.toContain(proof.signature);
    expect(verifyMock).not.toHaveBeenCalled();
    expect(x402Mock).not.toHaveBeenCalled();
    expect(billingMock).not.toHaveBeenCalled();
  });
});
