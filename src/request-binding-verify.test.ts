/**
 * POST /sentinel/verify request binding. Engine is mocked. No network.
 * The export signer is an ephemeral key written only to a temp public key
 * document. Private material stays in process memory.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
  clearExportSignerReadinessCache,
  generateExportKeyPair,
  publicKeyOkpX,
  verifySignedCanonicalExport,
  type SignedCanonicalExport,
} from './canonical-export.js';
import { computeRequestHash } from './request-binding.js';
import type { SentinelVerifyResponse } from './types.js';

const verifyMock = vi.mocked(verify);
const TEST_KID = 'tp-sentinel-export-binding-test';
const CLIENT_HASH = `sha256:${'ab'.repeat(32)}`;

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/request-binding-v2.json'),
    'utf8',
  ),
) as { vectors: Array<{ id: string; body: Record<string, unknown>; requestHash?: string; serializedVariants?: string[] }> };

function vector(id: string) {
  const found = fixture.vectors.find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
}

const savedEnv = {
  SERV_API_KEY: process.env.SERV_API_KEY,
  SENTINEL_X402_ENABLED: process.env.SENTINEL_X402_ENABLED,
  SENTINEL_AUTH_REQUIRED: process.env.SENTINEL_AUTH_REQUIRED,
  SENTINEL_EXPORT_PRIVATE_KEY: process.env.SENTINEL_EXPORT_PRIVATE_KEY,
  SENTINEL_EXPORT_KEY_ID: process.env.SENTINEL_EXPORT_KEY_ID,
  SENTINEL_EXPORT_TTL_SECONDS: process.env.SENTINEL_EXPORT_TTL_SECONDS,
  SENTINEL_EXPORT_KEYS_PATH: process.env.SENTINEL_EXPORT_KEYS_PATH,
  SENTINEL_GLOBAL_RATE_LIMIT: process.env.SENTINEL_GLOBAL_RATE_LIMIT,
  SENTINEL_MANDATE_PROOF_ENFORCE: process.env.SENTINEL_MANDATE_PROOF_ENFORCE,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  SHADOW_ADR0020: process.env.SHADOW_ADR0020,
};

let publicKey: ReturnType<typeof generateExportKeyPair>['publicKey'];
let keysDir: string;

function engineResponse(
  verdict: 'ALLOW' | 'BLOCK' | 'UNCERTAIN',
  mode: string,
): SentinelVerifyResponse {
  return {
    id: 'sent_bind_endpoint',
    verdict,
    confidence: verdict === 'ALLOW' ? 0.91 : 0.2,
    reasoning: 'endpoint binding',
    objections: [],
    mode: mode as SentinelVerifyResponse['mode'],
    tier: 'checkpoint',
    meta: {
      duration_ms: 4,
      models_used: ['serv-nano'],
      verified_at: '2026-11-14T12:00:00.000Z',
    },
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
      return body as Record<string, unknown>;
    },
  };
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const ctx = mockRes();
  await handler(
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      query: {},
    } as never,
    ctx.res as never,
  );
  return ctx;
}

function exportsOf(body: Record<string, unknown>) {
  const v1 = body.signed_export as SignedCanonicalExport;
  const v2 = body.signed_export_v2 as SignedCanonicalExport;
  expect(v1?.canonical).toEqual(expect.any(String));
  expect(v2?.canonical).toEqual(expect.any(String));
  const c1 = JSON.parse(v1.canonical) as { requestHash?: string; verdict?: string; artifactSchema?: string };
  const c2 = JSON.parse(v2.canonical) as { requestHash?: string; verdict?: string; artifactSchema?: string };
  return { v1, v2, c1, c2 };
}

function expectBound(body: Record<string, unknown>, request: unknown, verdict: string) {
  const expected = computeRequestHash(request);
  const { v1, v2, c1, c2 } = exportsOf(body);
  expect(c1.artifactSchema).toBe('sentinel.verdict.canonical.v1');
  expect(c2.artifactSchema).toBe('sentinel.verdict.canonical.v2');
  expect(c1.requestHash).toBe(expected);
  expect(c2.requestHash).toBe(expected);
  expect(c1.verdict).toBe(verdict);
  expect(c2.verdict).toBe(verdict);
  expect(c1.requestHash).not.toBe(CLIENT_HASH);
  const now = v1.signedAt;
  expect(verifySignedCanonicalExport(v1, publicKey, { nowSeconds: now }).ok).toBe(true);
  expect(verifySignedCanonicalExport(v2, publicKey, { nowSeconds: now }).ok).toBe(true);
  const tampered = {
    ...v1,
    canonical: v1.canonical.replace(expected, `sha256:${'11'.repeat(32)}`),
  };
  expect(verifySignedCanonicalExport(tampered, publicKey, { nowSeconds: now }).ok).toBe(false);
  return expected;
}

beforeAll(() => {
  const pair = generateExportKeyPair();
  publicKey = pair.publicKey;
  keysDir = mkdtempSync(join(tmpdir(), 'sentinel-binding-'));
  const keysPath = join(keysDir, 'keys.json');
  writeFileSync(
    keysPath,
    JSON.stringify({
      schema: 'thoughtproof.keys.v1',
      keys: [
        {
          kty: 'OKP',
          crv: 'Ed25519',
          x: publicKeyOkpX(pair.publicKey),
          kid: TEST_KID,
          alg: 'EdDSA',
          status: 'active',
          notBefore: '2020-01-01T00:00:00Z',
          notAfter: null,
        },
      ],
    }),
  );
  process.env.SENTINEL_EXPORT_PRIVATE_KEY = pair.privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string;
  process.env.SENTINEL_EXPORT_KEY_ID = TEST_KID;
  process.env.SENTINEL_EXPORT_KEYS_PATH = keysPath;
  process.env.SENTINEL_EXPORT_TTL_SECONDS = '86400';
});

afterAll(() => {
  const restore = (name: keyof typeof savedEnv) => {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  (Object.keys(savedEnv) as Array<keyof typeof savedEnv>).forEach(restore);
  clearExportSignerReadinessCache();
  rmSync(keysDir, { recursive: true, force: true });
});

beforeEach(() => {
  verifyMock.mockReset();
  process.env.SERV_API_KEY = 'test-serv-key-not-a-secret';
  delete process.env.SENTINEL_X402_ENABLED;
  delete process.env.SENTINEL_AUTH_REQUIRED;
  delete process.env.SENTINEL_MANDATE_PROOF_ENFORCE;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.SHADOW_ADR0020;
  process.env.SENTINEL_GLOBAL_RATE_LIMIT = '10000';
  clearExportSignerReadinessCache();
});

describe('POST /sentinel/verify request binding', () => {
  it('signs hash(A) on both formats for every verdict, and a changed mandate or command differs', async () => {
    const decision = vector('decision-builder');
    const withMandate = vector('decision-with-mandate-kind');
    verifyMock.mockResolvedValue(engineResponse('ALLOW', 'action_authorization'));
    const allow = await post(decision.body);
    expect(allow.statusCode).toBe(200);
    expect(allow.body.verdict).toBe('ALLOW');
    const hashA = expectBound(allow.body, decision.body, 'ALLOW');
    expect(hashA).toBe(decision.requestHash);

    const file = join(keysDir, 'response.json');
    writeFileSync(file, JSON.stringify(allow.body));
    const verified = JSON.parse(
      execFileSync(
        process.execPath,
        [
          'scripts/verify-canonical-export.mjs',
          file,
          '--keys',
          process.env.SENTINEL_EXPORT_KEYS_PATH as string,
          '--now',
          String((allow.body.signed_export as SignedCanonicalExport).signedAt),
          '--schema',
          'all',
        ],
        { encoding: 'utf8' },
      ),
    ) as { ok: boolean; verified_schemas: string[] };
    expect(verified.ok).toBe(true);
    expect(verified.verified_schemas).toEqual([
      'sentinel.verdict.canonical.v1',
      'sentinel.verdict.canonical.v2',
    ]);

    verifyMock.mockResolvedValue(engineResponse('BLOCK', 'action_authorization'));
    const block = await post(decision.body);
    expect(block.body.verdict).toBe('BLOCK');
    expect(expectBound(block.body, decision.body, 'BLOCK')).toBe(hashA);

    verifyMock.mockResolvedValue(engineResponse('UNCERTAIN', 'action_authorization'));
    const uncertain = await post(decision.body);
    expect(uncertain.body.verdict).toBe('UNCERTAIN');
    expect(expectBound(uncertain.body, decision.body, 'UNCERTAIN')).toBe(hashA);

    verifyMock.mockResolvedValue(engineResponse('ALLOW', 'action_authorization'));
    const mandate = await post(withMandate.body);
    const hashMandate = expectBound(mandate.body, withMandate.body, 'ALLOW');
    expect(hashMandate).toBe(withMandate.requestHash);
    expect(hashMandate).not.toBe(hashA);

    const commandA = {
      ...decision.body,
      mandate: { kind: 'local_command', action: { kind: 'local_command', command: 'git status' } },
    };
    const commandB = {
      ...decision.body,
      mandate: { kind: 'local_command', action: { kind: 'local_command', command: 'git diff' } },
    };
    const signedA = await post(commandA);
    const signedB = await post(commandB);
    const hashCommandA = expectBound(signedA.body, commandA, 'ALLOW');
    const hashCommandB = expectBound(signedB.body, commandB, 'ALLOW');
    expect(hashCommandA).not.toBe(hashCommandB);
    expect(hashCommandA).not.toBe(hashA);
  });

  it('keeps the hash when keys are reordered or pretty-printed, and changes it for spaces inside a string', async () => {
    const decision = vector('decision-builder');
    const spaced = vector('inside-string-whitespace');
    verifyMock.mockResolvedValue(engineResponse('ALLOW', 'action_authorization'));
    const hashes = [];
    for (const serialized of decision.serializedVariants ?? []) {
      const ctx = await post(JSON.parse(serialized));
      hashes.push(expectBound(ctx.body, JSON.parse(serialized), 'ALLOW'));
    }
    expect(hashes).toEqual([decision.requestHash, decision.requestHash]);

    const inside = await post(spaced.body);
    const hashInside = expectBound(inside.body, spaced.body, 'ALLOW');
    expect(hashInside).toBe(spaced.requestHash);
    expect(hashInside).not.toBe(decision.requestHash);
  });

  it('binds the trade body and ignores headers and credentials', async () => {
    const trade = vector('trade-builder');
    verifyMock.mockResolvedValue(engineResponse('ALLOW', 'trade_execution'));
    const first = await post(trade.body, {
      'x-sentinel-key': 'binding-test-key-a',
      'user-agent': 'unit-test',
      'payment-signature': 'not-part-of-the-preimage',
    });
    const second = await post(trade.body, {
      'x-sentinel-key': 'binding-test-key-b',
      'user-agent': 'other-agent',
      'payment-signature': 'also-not-hashed',
    });
    const hash1 = expectBound(first.body, trade.body, 'ALLOW');
    const hash2 = expectBound(second.body, trade.body, 'ALLOW');
    expect(hash1).toBe(trade.requestHash);
    expect(hash2).toBe(hash1);
    const canonical = (first.body.signed_export as SignedCanonicalExport).canonical;
    expect(canonical).not.toContain('binding-test-key-a');
    expect(canonical).not.toContain('not-part-of-the-preimage');
  });

  it('hashes the received body, including trailing spaces the validator trims and nested unknown fields', async () => {
    const raw = {
      claim: 'run_command: git status ',
      evidence: 'because ',
      mode: 'action_authorization',
      tier: 'checkpoint',
    };
    verifyMock.mockResolvedValue(engineResponse('ALLOW', 'action_authorization'));
    const ctx = await post(raw);
    expectBound(ctx.body, raw, 'ALLOW');
    const trimmed = {
      claim: 'run_command: git status',
      evidence: 'because',
      mode: 'action_authorization',
      tier: 'checkpoint',
    };
    expect(computeRequestHash(raw)).not.toBe(computeRequestHash(trimmed));
    expect(verifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ claim: 'run_command: git status', evidence: 'because' }),
    );

    const base = vector('decision-builder').body;
    const plain = {
      ...base,
      mandate: { kind: 'local_command', action: { kind: 'local_command' } },
    };
    const extra = {
      ...base,
      mandate: { kind: 'local_command', action: { kind: 'local_command' }, extra: 'kept' },
    };
    verifyMock.mockClear();
    const plainRes = await post(plain);
    const extraRes = await post(extra);
    const plainHash = expectBound(plainRes.body, plain, 'ALLOW');
    const extraHash = expectBound(extraRes.body, extra, 'ALLOW');
    expect(extraHash).not.toBe(plainHash);
    const calls = verifyMock.mock.calls.map((call) => call[0] as { mandate?: { extra?: string } });
    expect(calls[0]?.mandate).not.toHaveProperty('extra');
    expect(calls[1]?.mandate).not.toHaveProperty('extra');
  });

  it('does not echo a client-supplied requestHash, and a top-level unknown field is not signed', async () => {
    const decision = vector('decision-builder').body;
    const nested = {
      ...decision,
      proposed_action: { command: 'git status', requestHash: CLIENT_HASH },
    };
    verifyMock.mockResolvedValue(engineResponse('ALLOW', 'action_authorization'));
    const signed = await post(nested);
    const bound = expectBound(signed.body, nested, 'ALLOW');
    expect(bound).not.toBe(CLIENT_HASH);
    expect((signed.body.signed_export as SignedCanonicalExport).canonical).not.toContain(CLIENT_HASH);
    expect((signed.body.signed_export_v2 as SignedCanonicalExport).canonical).toContain(bound);

    verifyMock.mockClear();
    const clientBody = { ...decision, requestHash: CLIENT_HASH };
    const rejected = await post(clientBody);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).not.toHaveProperty('verdict');
    expect(rejected.body).not.toHaveProperty('signed_export');
    expect(rejected.body).not.toHaveProperty('signed_export_v2');
    expect(JSON.stringify(rejected.body)).not.toContain(CLIENT_HASH);
    expect(verifyMock).not.toHaveBeenCalled();
    expect(computeRequestHash(clientBody)).not.toBe(CLIENT_HASH);
    expect(computeRequestHash(clientBody)).not.toBe(computeRequestHash(decision));

    const unknown = vector('unknown-extra-field');
    const unknownRes = await post(unknown.body);
    expect(unknownRes.statusCode).toBe(400);
    expect(unknownRes.body).not.toHaveProperty('signed_export');
    expect(unknownRes.body).not.toHaveProperty('verdict');
    expect(String((unknownRes.body as { code?: string }).code)).not.toBe('ALLOW');
    expect(computeRequestHash(unknown.body)).toBe(unknown.requestHash);
    expect(unknown.requestHash).not.toBe(vector('decision-builder').requestHash);
  });

  it('rejects lone surrogates with no ALLOW and no hash-bearing signed export', async () => {
    verifyMock.mockResolvedValue(engineResponse('ALLOW', 'action_authorization'));
    const bodies = [
      vector('lone-high-surrogate-value').body,
      vector('lone-low-surrogate-value').body,
      vector('lone-surrogate-key').body,
      {
        claim: 'run_command: git status \uD800',
        evidence: 'emoji pair is fine, this is not',
        mode: 'action_authorization',
        tier: 'checkpoint',
      },
    ];
    for (const body of bodies) {
      verifyMock.mockClear();
      const ctx = await post(body);
      expect(ctx.statusCode).toBe(400);
      expect(ctx.body).not.toHaveProperty('verdict');
      expect(ctx.body).not.toHaveProperty('signed_export');
      expect(ctx.body).not.toHaveProperty('signed_export_v2');
      expect(JSON.stringify(ctx.body)).not.toMatch(/"verdict"\s*:\s*"ALLOW"/);
      expect(JSON.stringify(ctx.body)).not.toContain('sha256:');
      expect(verifyMock).not.toHaveBeenCalled();
    }

    const emoji = vector('valid-surrogate-pair');
    verifyMock.mockResolvedValue(engineResponse('ALLOW', 'action_authorization'));
    const ok = await post(emoji.body);
    expect(ok.statusCode).toBe(200);
    expect(expectBound(ok.body, emoji.body, 'ALLOW')).toBe(emoji.requestHash);
  });
});
