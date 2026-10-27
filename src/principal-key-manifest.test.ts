/**
 * Offline principal-manifest checks. Key pairs are generated in this file.
 * No network, no provider keys, and no private keys written to the repo.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - canonicalize types are loose; runtime export is the function
import canonicalize from 'canonicalize';
import {
  PRINCIPAL_MANDATE_PURPOSE,
  PRINCIPAL_MANDATE_SCHEMA,
  principalMandateSignedBytes,
  registerPrincipalKey,
  verdictWithPrincipalCheck,
  verifyPrincipalMandate,
  type PrincipalKeyManifest,
  type PrincipalManifestStore,
  type PrincipalMandateResult,
  type PrincipalProofFields,
  type PrincipalPublicKey,
} from './principal-key-manifest.js';

const NOW = 1_800_000_000;
const ACCOUNT = 'acct-stage3';
const OTHER = 'acct-other';
const KID = 'kid-stage3';
const OTHER_KID = 'kid-other';
const ENV = 'test-env';
const PINNED_JCS =
  '{"account_id":"acct-stage3","environment":"test-env","exp":1800000060,"iat":1800000000,"mandate":{"action":{"amount":1,"kind":"value_transfer"},"kind":"value_transfer"},"nonce":"nonce-stage3-1","principal_kid":"kid-stage3","purpose":"action_authorization","schema_version":"sentinel.mandate-proof.v1"}';

const MANDATE = {
  kind: 'value_transfer',
  action: { kind: 'value_transfer', amount: 1 },
};

const primary = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

function okpX(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

const PRIMARY_X = okpX(primary.publicKey);
const OTHER_X = okpX(other.publicKey);

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function fields(over: Partial<PrincipalProofFields> = {}): PrincipalProofFields {
  return {
    schema_version: PRINCIPAL_MANDATE_SCHEMA,
    nonce: 'nonce-stage3-1',
    iat: NOW,
    exp: NOW + 60,
    account_id: ACCOUNT,
    environment: ENV,
    purpose: PRINCIPAL_MANDATE_PURPOSE,
    principal_kid: KID,
    ...over,
  };
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

function pinned(
  keys: PrincipalPublicKey[] = [keyEntry()],
  accountId = ACCOUNT,
): PrincipalKeyManifest {
  return { accountId, keys };
}

function signedProof(
  privateKey: KeyObject,
  proofFields: PrincipalProofFields,
  mandate: unknown = MANDATE,
): PrincipalProofFields & { signature: string } {
  const bytes = principalMandateSignedBytes(mandate, proofFields);
  if (!bytes) throw new Error('fixture bytes were not produced');
  return {
    ...proofFields,
    signature: sign(null, bytes, privateKey).toString('hex'),
  };
}

function throwingStore(): PrincipalManifestStore {
  return {
    load() {
      throw new Error('store down');
    },
  };
}

async function check(options: {
  accountId?: string | null;
  mandate?: unknown;
  proof?: unknown;
  now?: number;
  manifest?: unknown;
  store?: PrincipalManifestStore | null;
  requestBodyKeyManifest?: unknown;
  onLoad?: (accountId: string) => void;
}): Promise<PrincipalMandateResult> {
  const store = options.store === undefined
    ? {
        async load(accountId: string) {
          options.onLoad?.(accountId);
          return {
            answered: true as const,
            manifest: options.manifest === undefined ? pinned() : options.manifest,
          };
        },
      }
    : options.store;
  return verifyPrincipalMandate({
    authenticatedAccountId: options.accountId === null ? undefined : (options.accountId ?? ACCOUNT),
    mandate: options.mandate === undefined ? MANDATE : options.mandate,
    mandateProof: options.proof === undefined
      ? signedProof(primary.privateKey, fields())
      : options.proof,
    nowSeconds: options.now ?? NOW,
    store,
    requestBodyKeyManifest: options.requestBodyKeyManifest,
  });
}

function expectBlock(result: PrincipalMandateResult, reason: string): void {
  expect(result).toEqual({ ok: false, verdict: 'BLOCK', reason });
  expect(result).not.toHaveProperty('mandateSource');
}

describe('principal key manifest', () => {
  it('accepts a valid signature and does not return ALLOW', async () => {
    const calls: string[] = [];
    const result = await check({ onLoad: (accountId) => calls.push(accountId) });
    expect(result).toEqual({
      ok: true,
      accountId: ACCOUNT,
      principalKid: KID,
      mandateSource: 'principal_signed',
    });
    expect(result).not.toHaveProperty('verdict');
    expect(JSON.stringify(result)).not.toContain('ALLOW');
    expect(calls).toEqual([ACCOUNT]);
  });

  it('accepts the same signature with a 0x hex prefix', async () => {
    const proof = signedProof(primary.privateKey, fields());
    const prefixed = await check({ proof: { ...proof, signature: `0x${proof.signature}` } });
    expect(prefixed).toMatchObject({ ok: true, mandateSource: 'principal_signed' });
    expect(prefixed).not.toHaveProperty('verdict');
  });

  it('rejects a signature from a different key', async () => {
    const result = await check({
      proof: signedProof(other.privateKey, fields()),
    });
    expectBlock(result, 'signature_invalid');
  });

  it('rejects a revoked key inside its old window', async () => {
    const result = await check({
      manifest: pinned([keyEntry({ status: 'revoked' })]),
    });
    expectBlock(result, 'revoked');
  });

  it('rejects a revoked key outside its window as revoked', async () => {
    const result = await check({
      manifest: pinned([
        keyEntry({ status: 'revoked', notBefore: iso(NOW - 5000), notAfter: iso(NOW - 4000) }),
      ]),
    });
    expectBlock(result, 'revoked');
  });

  it('rejects a retired key for a new request even when the window contains now', async () => {
    const result = await check({
      manifest: pinned([keyEntry({ status: 'retired' })]),
      proof: signedProof(primary.privateKey, fields({ iat: NOW - 10, exp: NOW + 60 })),
    });
    expectBlock(result, 'retired');
  });

  it('rejects a key that is not yet valid at receipt time', async () => {
    const result = await check({
      manifest: pinned([keyEntry({ notBefore: iso(NOW + 1), notAfter: iso(NOW + 1000) })]),
      proof: signedProof(primary.privateKey, fields({ iat: NOW, exp: NOW + 60 })),
    });
    expectBlock(result, 'key_not_yet_valid');
  });

  it('rejects a key that is expired at receipt time', async () => {
    const result = await check({
      manifest: pinned([keyEntry({ notBefore: iso(NOW - 1000), notAfter: iso(NOW - 1) })]),
      proof: signedProof(primary.privateKey, fields({ iat: NOW, exp: NOW + 60 })),
    });
    expectBlock(result, 'key_expired');
  });

  it('treats notBefore and notAfter as inclusive at the receipt second', async () => {
    const result = await check({
      manifest: pinned([keyEntry({ notBefore: iso(NOW), notAfter: iso(NOW) })]),
    });
    expect(result).toMatchObject({ ok: true, principalKid: KID });
    expect(result).not.toHaveProperty('verdict');
  });

  it('does not let the 30-second skew widen the key window', async () => {
    const result = await check({
      manifest: pinned([keyEntry({ notBefore: iso(NOW + 30), notAfter: iso(NOW + 1000) })]),
      proof: signedProof(primary.privateKey, fields({ iat: NOW, exp: NOW + 60 })),
    });
    expectBlock(result, 'key_not_yet_valid');
  });

  it('checks clock-skew boundaries on the proof window', async () => {
    const atSkew = await check({
      proof: signedProof(primary.privateKey, fields({ iat: NOW + 30, exp: NOW + 60 })),
    });
    expect(atSkew).toMatchObject({ ok: true });

    const pastSkew = await check({
      proof: signedProof(primary.privateKey, fields({ iat: NOW + 31, exp: NOW + 90 })),
    });
    expectBlock(pastSkew, 'not_yet_valid');

    const stillFresh = await check({
      proof: signedProof(primary.privateKey, fields({ iat: NOW - 80, exp: NOW - 29 })),
    });
    expect(stillFresh).toMatchObject({ ok: true });

    let loads = 0;
    const justExpired = await check({
      proof: signedProof(primary.privateKey, fields({ iat: NOW - 80, exp: NOW - 30 })),
      store: {
        load() {
          loads += 1;
          throw new Error('store down');
        },
      },
    });
    expectBlock(justExpired, 'expired');
    expect(loads).toBe(0);

    const zeroWindow = await check({
      proof: signedProof(primary.privateKey, fields({ iat: NOW, exp: NOW })),
    });
    expectBlock(zeroWindow, 'non_positive_window');

    const reversed = await check({
      proof: signedProof(primary.privateKey, fields({ iat: NOW + 10, exp: NOW })),
    });
    expectBlock(reversed, 'non_positive_window');

    const maxWindow = await check({
      proof: signedProof(primary.privateKey, fields({ iat: NOW, exp: NOW + 300 })),
    });
    expect(maxWindow).toMatchObject({ ok: true });

    const tooLong = await check({
      proof: signedProof(primary.privateKey, fields({ iat: NOW, exp: NOW + 301 })),
    });
    expectBlock(tooLong, 'window_too_long');
  });

  it('rejects a tampered manifest public key', async () => {
    const result = await check({
      manifest: pinned([keyEntry({ x: OTHER_X })]),
    });
    expectBlock(result, 'signature_invalid');
  });

  it('rejects a tampered manifest status', async () => {
    const result = await check({
      manifest: pinned([keyEntry({ status: 'revoked' })]),
    });
    expectBlock(result, 'revoked');
  });

  it('rejects a tampered manifest notAfter', async () => {
    const result = await check({
      manifest: pinned([keyEntry({ notAfter: iso(NOW - 1) })]),
    });
    expectBlock(result, 'key_expired');
  });

  it('rejects a tampered mandate byte', async () => {
    const proof = signedProof(primary.privateKey, fields(), MANDATE);
    const result = await check({
      mandate: { ...MANDATE, action: { kind: 'value_transfer', amount: 2 } },
      proof,
    });
    expectBlock(result, 'signature_invalid');
  });

  it('rejects an unknown kid after the store has answered', async () => {
    const calls: string[] = [];
    const result = await check({
      onLoad: (accountId) => calls.push(accountId),
      proof: signedProof(other.privateKey, fields({ principal_kid: OTHER_KID })),
      manifest: pinned([
        keyEntry(),
        keyEntry({ kid: 'kid-retired', status: 'retired', x: OTHER_X }),
      ]),
    });
    expectBlock(result, 'unknown_kid');
    expect(calls).toEqual([ACCOUNT]);
  });

  it('treats an answered empty manifest as an unknown kid', async () => {
    const result = await check({ manifest: pinned([]) });
    expectBlock(result, 'unknown_kid');
    const missing = await check({
      store: { async load() { return { answered: true, manifest: null }; } },
    });
    expectBlock(missing, 'unknown_kid');
  });

  it('selects the named kid in the authenticated account manifest', async () => {
    const manifest = pinned([
      keyEntry({ kid: 'kid-revoked', status: 'revoked', x: OTHER_X }),
      keyEntry(),
    ]);
    const selected = await check({ manifest });
    expect(selected).toMatchObject({ ok: true, principalKid: KID });
    const revokedSibling = await check({
      manifest,
      proof: signedProof(other.privateKey, fields({ principal_kid: 'kid-revoked' })),
    });
    expectBlock(revokedSibling, 'revoked');
  });

  it('rejects a malformed manifest and does not return ALLOW', async () => {
    const secret = 'fixture-private-seed-not-a-key';
    const cases: unknown[] = [
      [],
      'not-a-manifest',
      { accountId: ACCOUNT, keys: 'nope' },
      { accountId: ACCOUNT },
      { accountId: OTHER, keys: [keyEntry()] },
      { schema: 'thoughtproof.keys.v1', accountId: ACCOUNT, keys: [keyEntry()] },
      {
        version: 'v0',
        keys: [{ pubkey: PRIMARY_X, status: 'active', not_before: iso(NOW - 10), not_after: null }],
      },
      { accountId: ACCOUNT, keys: [keyEntry(), keyEntry()] },
      { accountId: ACCOUNT, keys: [{ ...keyEntry(), d: secret }] },
      { accountId: ACCOUNT, keys: [keyEntry({ x: 'not-a-key' })] },
      { accountId: ACCOUNT, keys: [keyEntry({ notBefore: 'yesterday' })] },
      { accountId: ACCOUNT, jwks_url: 'https://example.invalid/keys.json', keys: [keyEntry()] },
    ];
    for (const manifest of cases) {
      const result = await check({ manifest });
      expect(result).toEqual({ ok: false, httpStatus: 503, code: 'MANIFEST_MALFORMED' });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain('ALLOW');
    }
  });

  it('rejects an account mismatch and does not load the signed account', async () => {
    const calls: string[] = [];
    const result = await check({
      onLoad: (accountId) => calls.push(accountId),
      proof: signedProof(primary.privateKey, fields({ account_id: OTHER })),
      manifest: pinned([keyEntry()], OTHER),
    });
    expectBlock(result, 'account_mismatch');
    expect(calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(OTHER);
  });

  it('does not let a missing authenticated account be filled from the proof', async () => {
    let called = false;
    const result = await check({
      accountId: null,
      proof: signedProof(primary.privateKey, fields({ account_id: OTHER })),
      store: {
        async load() {
          called = true;
          return { answered: true, manifest: pinned() };
        },
      },
    });
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });
    expect(called).toBe(false);
  });

  it('a valid signature does not upgrade the verdict to ALLOW', async () => {
    const result = await check();
    expect(result).toMatchObject({ ok: true, mandateSource: 'principal_signed' });
    expect(verdictWithPrincipalCheck('BLOCK', result)).toBe('BLOCK');
    expect(verdictWithPrincipalCheck('UNCERTAIN', result)).toBe('UNCERTAIN');
    expect(verdictWithPrincipalCheck('ALLOW', result)).toBe('ALLOW');

    const revoked = await check({ manifest: pinned([keyEntry({ status: 'revoked' })]) });
    expect(verdictWithPrincipalCheck('ALLOW', revoked)).toBe('BLOCK');
    expect(verdictWithPrincipalCheck('UNCERTAIN', revoked)).toBe('BLOCK');
    expect(verdictWithPrincipalCheck('BLOCK', revoked)).toBe('BLOCK');
  });

  it('does not turn a store failure into ALLOW or weaken an existing BLOCK', async () => {
    const down = await check({ store: null });
    expect(down).toEqual({ ok: false, httpStatus: 503, code: 'MANIFEST_UNAVAILABLE' });
    expect(verdictWithPrincipalCheck('ALLOW', down)).toBe('UNCERTAIN');
    expect(verdictWithPrincipalCheck('UNCERTAIN', down)).toBe('UNCERTAIN');
    expect(verdictWithPrincipalCheck('BLOCK', down)).toBe('BLOCK');

    const thrown = await check({ store: throwingStore() });
    expect(thrown).toEqual({ ok: false, httpStatus: 503, code: 'MANIFEST_UNAVAILABLE' });
    expect(verdictWithPrincipalCheck('BLOCK', thrown)).toBe('BLOCK');
    expect(verdictWithPrincipalCheck('ALLOW', thrown)).not.toBe('ALLOW');

    const silent = await check({
      store: { async load() { return { answered: false }; } },
    });
    expect(silent).toEqual({ ok: false, httpStatus: 503, code: 'MANIFEST_UNAVAILABLE' });
  });

  it('does not read a request-body key manifest as the principal manifest', async () => {
    const body = {
      version: 'v0',
      keys: [{
        pubkey: OTHER_X,
        status: 'active',
        not_before: iso(NOW - 10),
        not_after: iso(NOW + 10),
      }],
    };
    const attacked = await check({
      requestBodyKeyManifest: body,
      proof: signedProof(other.privateKey, fields()),
    });
    expectBlock(attacked, 'signature_invalid');

    const storedF1 = await check({
      manifest: body,
      requestBodyKeyManifest: body,
      proof: signedProof(other.privateKey, fields()),
    });
    expect(storedF1).toEqual({ ok: false, httpStatus: 503, code: 'MANIFEST_MALFORMED' });
  });

  it('rejects a caller-supplied JWKS URL', async () => {
    const proof = signedProof(primary.privateKey, fields());
    const result = await check({
      proof: { ...proof, jwks_url: 'https://example.invalid/jwks.json' },
    });
    expectBlock(result, 'caller_trust_anchor');
  });

  it('rejects a registration authenticated only as the verify caller', async () => {
    let writes = 0;
    const result = registerPrincipalKey({
      apiKey: 'sk_fixture_verify_caller',
      accountId: ACCOUNT,
      manifest: pinned(),
      requestBodyKeyManifest: { version: 'v0', keys: [] },
      write: () => { writes += 1; },
    });
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'REGISTRATION_UNAUTHORIZED' });
    expect(writes).toBe(0);
    expect(JSON.stringify(result)).not.toContain('sk_fixture_verify_caller');
    expect(result).not.toHaveProperty('verdict');
  });

  it('rejects a registration authenticated only by X-Sentinel-Agent-Id', async () => {
    let writes = 0;
    const result = registerPrincipalKey({
      agentIdHeader: 'agent-header-fixture',
      accountId: ACCOUNT,
      manifest: pinned(),
      write: () => { writes += 1; },
    });
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'REGISTRATION_UNAUTHORIZED' });
    expect(writes).toBe(0);
    expect(JSON.stringify(result)).not.toContain('agent-header-fixture');
  });

  it('rejects registration when both caller credentials are present', async () => {
    let writes = 0;
    const result = registerPrincipalKey({
      apiKey: 'sk_fixture_verify_caller',
      agentIdHeader: 'agent-header-fixture',
      accountId: ACCOUNT,
      manifest: pinned(),
      requestBodyKeyManifest: pinned(),
      write: () => { writes += 1; },
    });
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'REGISTRATION_UNAUTHORIZED' });
    expect(writes).toBe(0);
  });

  it('signs UTF-8 JCS without the export domain prefix or the signature field', () => {
    const bytes = principalMandateSignedBytes(MANDATE, fields());
    expect(bytes?.toString('utf8')).toBe(PINNED_JCS);
    expect(bytes?.includes(0)).toBe(false);
    expect(bytes?.toString('utf8')).not.toContain('thoughtproof.sentinel.export.v1');
    expect(bytes?.toString('utf8')).not.toContain('signature');
    const independent = (canonicalize as (value: unknown) => string)({
      schema_version: 'sentinel.mandate-proof.v1',
      mandate: MANDATE,
      nonce: 'nonce-stage3-1',
      iat: NOW,
      exp: NOW + 60,
      principal_kid: KID,
      account_id: ACCOUNT,
      environment: ENV,
      purpose: 'action_authorization',
    });
    expect(independent).toBe(PINNED_JCS);
  });

  it('does not accept an export-domain signature or an evidence signature', async () => {
    const jcs = Buffer.from(PINNED_JCS, 'utf8');
    const exportBytes = Buffer.concat([
      Buffer.from('thoughtproof.sentinel.export.v1', 'utf8'),
      Buffer.from([0]),
      jcs,
    ]);
    const evidenceBytes = Buffer.from(
      (canonicalize as (value: unknown) => string)({ payload: MANDATE }),
      'utf8',
    );
    const exportSigned = await check({
      proof: { ...fields(), signature: sign(null, exportBytes, primary.privateKey).toString('hex') },
    });
    const evidenceSigned = await check({
      proof: { ...fields(), signature: sign(null, evidenceBytes, primary.privateKey).toString('hex') },
    });
    expectBlock(exportSigned, 'signature_invalid');
    expectBlock(evidenceSigned, 'signature_invalid');
  });

  it('rejects an unusable receipt time without reading the store', async () => {
    let called = false;
    const store: PrincipalManifestStore = {
      async load() {
        called = true;
        return { answered: true, manifest: pinned() };
      },
    };
    const fractional = await check({ now: NOW + 0.5, store });
    const negative = await check({ now: -1, store });
    expect(fractional).toEqual({ ok: false, httpStatus: 503, code: 'RECEIPT_TIME_UNUSABLE' });
    expect(negative).toEqual({ ok: false, httpStatus: 503, code: 'RECEIPT_TIME_UNUSABLE' });
    expect(called).toBe(false);
    expect(verdictWithPrincipalCheck('ALLOW', fractional)).toBe('UNCERTAIN');
    expect(verdictWithPrincipalCheck('BLOCK', fractional)).toBe('BLOCK');
  });

  it('stays off the verify handler and the paid-suite path filter', () => {
    const source = readFileSync(new URL('./principal-key-manifest.ts', import.meta.url), 'utf8');
    const verify = readFileSync(new URL('../api/sentinel/verify.ts', import.meta.url), 'utf8');
    const workflow = readFileSync(
      new URL('../.github/workflows/action-authorization-suite.yml', import.meta.url),
      'utf8',
    );
    expect(verify).not.toContain('principal-key-manifest');
    expect(verify).not.toContain('verifyPrincipalMandate');
    expect(source).not.toContain('mandate-replay-store');
    expect(source).not.toContain('api/sentinel');
    expect(source).not.toContain('src/engine');
    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('upstash');
    expect(source).not.toContain('BEGIN PRIVATE');
    expect(source).not.toContain('action-authorization-suite');
    expect(workflow).toContain('scenarios/action-authorization-suite.json');
    expect(workflow).toContain('scripts/action-authorization-suite.mjs');
    expect(workflow).toContain('scripts/lib/action-auth-suite-metrics.mjs');
    expect(workflow).toContain('scripts/lib/action-auth-suite-receipt.mjs');
    expect(workflow).toContain('.github/workflows/action-authorization-suite.yml');
    expect(workflow).toContain('src/engine/**');
    expect(workflow).not.toContain('principal-key-manifest');
  });
});
