/**
 * Offline proof of key → account mapping, rotation, and wrong-account
 * results. Key pairs are generated here. No network and no provider keys.
 */
import { generateKeyPairSync, sign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyWrongAccount,
  historicalPrincipalVerification,
  migrateApiKeyToAccount,
  verdictFromHistoricalVerification,
} from './mandate-account-migration.js';
import { normalizeMandate } from './mandate-normalize.js';
import { stage4FailureClass } from './mandate-no-auth.js';
import {
  PRINCIPAL_ENVIRONMENTS,
  PRINCIPAL_MANDATE_DOMAIN,
  PRINCIPAL_MANDATE_PURPOSE,
  PRINCIPAL_MANDATE_SCHEMA,
  PRINCIPAL_MANIFEST_LOAD_DEADLINE_MS,
  principalMandateSignedBytes,
  registerPrincipalKey,
  verdictWithPrincipalCheck,
  verifyPrincipalMandate,
  type PrincipalKeyManifest,
  type PrincipalProofFields,
  type PrincipalPublicKey,
} from './principal-key-manifest.js';

const NOW = 1_800_000_000;
const ACCOUNT = 'acct-migrated';
const OTHER = 'acct-other';
const LEGACY_KEY = 'sk_legacy_fixture';
const NEW_KEY = 'sk_rotated_fixture';
const OLD_KID = 'kid-retired';
const NEW_KID = 'kid-active';

const oldKey = generateKeyPairSync('ed25519');
const newKey = generateKeyPairSync('ed25519');

function okpX(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

const OLD_X = okpX(oldKey.publicKey);
const NEW_X = okpX(newKey.publicKey);

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const MANDATE = {
  kind: 'value_transfer',
  granted: { maxAmount: 1, asset: 'USDC', recipient: 'recipient-fixture' },
  action: { kind: 'value_transfer', amount: 1, asset: 'USDC', recipient: 'recipient-fixture' },
};

function fields(over: Partial<PrincipalProofFields> = {}): PrincipalProofFields {
  return {
    schema_version: PRINCIPAL_MANDATE_SCHEMA,
    nonce: 'nonce-migration-1',
    iat: NOW,
    exp: NOW + 60,
    account_id: ACCOUNT,
    environment: 'production',
    purpose: PRINCIPAL_MANDATE_PURPOSE,
    principal_kid: NEW_KID,
    ...over,
  };
}

function keyEntry(over: Partial<PrincipalPublicKey>): PrincipalPublicKey {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    x: NEW_X,
    kid: NEW_KID,
    status: 'active',
    notBefore: iso(NOW - 1000),
    notAfter: iso(NOW + 1000),
    ...over,
  };
}

function manifest(accountId = ACCOUNT): PrincipalKeyManifest {
  return {
    accountId,
    keys: [
      keyEntry({ kid: OLD_KID, status: 'retired', x: OLD_X }),
      keyEntry({ kid: NEW_KID, status: 'active', x: NEW_X }),
    ],
  };
}

function signed(privateKey: KeyObject, proof: PrincipalProofFields, mandate: unknown = MANDATE) {
  const bytes = principalMandateSignedBytes(mandate, proof);
  if (!bytes) throw new Error('fixture bytes were not produced');
  return {
    proof: { ...proof, signature: sign(null, bytes, privateKey).toString('hex') },
    bytes,
  };
}

async function check(options: {
  accountId?: string;
  proof: PrincipalProofFields & { signature: string };
  mandate?: unknown;
  document?: PrincipalKeyManifest;
}) {
  const document = options.document ?? manifest();
  const loads: string[] = [];
  const result = await verifyPrincipalMandate({
    authenticatedAccountId: options.accountId ?? ACCOUNT,
    mandate: options.mandate ?? MANDATE,
    mandateProof: options.proof,
    nowSeconds: NOW,
    targetEnvironment: 'production',
    store: {
      load(accountId: string) {
        loads.push(accountId);
        return { answered: true as const, manifest: document };
      },
    },
  });
  return { result, loads };
}

describe('key to account migration', () => {
  it('maps a migrated key record and fails closed for a pre-account key', () => {
    const env = {
      SENTINEL_API_KEYS: `${LEGACY_KEY}:openserv:agent42:${ACCOUNT},${NEW_KEY}:acp:0xABC:${OTHER}`,
    };
    const mapped = migrateApiKeyToAccount({
      apiKey: LEGACY_KEY,
      requestAccountId: 'spoofed-account',
      agentIdHeader: 'agent42',
      env,
    });
    expect(mapped).toEqual({ ok: true, accountId: ACCOUNT });
    const other = migrateApiKeyToAccount({ apiKey: NEW_KEY, env });
    expect(other).toEqual({ ok: true, accountId: OTHER });

    const preAccount = migrateApiKeyToAccount({
      apiKey: LEGACY_KEY,
      requestAccountId: ACCOUNT,
      agentIdHeader: 'agent42',
      env: { SENTINEL_API_KEYS: `${LEGACY_KEY}:openserv:agent42` },
    });
    expect(preAccount).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });
    expect(stage4FailureClass('no_account')).toEqual({
      class: 'unverifiable',
      httpStatus: 503,
      code: 'ACCOUNT_UNAVAILABLE',
    });
    expect(JSON.stringify(preAccount)).not.toContain('ALLOW');
    expect(JSON.stringify(preAccount)).not.toContain('agent42');

    const removed = migrateApiKeyToAccount({
      apiKey: LEGACY_KEY,
      env: { SENTINEL_API_KEYS: `${NEW_KEY}:acp:0xABC:${ACCOUNT}` },
    });
    expect(removed).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });
    expect(removed).not.toMatchObject({ verdict: 'BLOCK', reason: 'retired' });
  });

  it('blocks a retired kid for a new authorization and keeps history off the execution path', async () => {
    const normalized = normalizeMandate(MANDATE);
    expect(normalized.ok).toBe(true);
    const proof = fields({ principal_kid: OLD_KID });
    const signedOld = signed(oldKey.privateKey, proof);
    expect(
      cryptoVerify(null, signedOld.bytes, oldKey.publicKey, Buffer.from(signedOld.proof.signature, 'hex')),
    ).toBe(true);

    const { result, loads } = await check({ proof: signedOld.proof });
    expect(result).toEqual({ ok: false, verdict: 'BLOCK', reason: 'retired' });
    expect(stage4FailureClass('retired_key')).toEqual({
      class: 'known_invalid',
      verdict: 'BLOCK',
      reason: 'retired',
    });
    expect(loads).toEqual([ACCOUNT]);
    expect(verdictWithPrincipalCheck('ALLOW', result)).toBe('BLOCK');
    expect(verdictWithPrincipalCheck('BLOCK', result)).toBe('BLOCK');
    expect(JSON.stringify(result)).not.toContain('ALLOW');

    for (const signatureMatched of [true, false]) {
      for (const keyStatus of ['active', 'retired', 'revoked'] as const) {
        const historical = historicalPrincipalVerification({ signatureMatched, keyStatus });
        expect(historical).toEqual({
          purpose: 'historical',
          authorizesExecution: false,
          signatureMatched,
          keyStatus,
          ok: false,
          verdict: 'BLOCK',
          reason: 'historical_not_authorization',
        });
        expect(historical).not.toHaveProperty('mandateSource');
        expect(verdictFromHistoricalVerification(historical, 'ALLOW')).toBe('BLOCK');
        expect(verdictFromHistoricalVerification(historical, 'BLOCK')).toBe('BLOCK');
        expect(verdictFromHistoricalVerification(historical, 'UNCERTAIN')).toBe('UNCERTAIN');
        expect(JSON.stringify(historical)).not.toContain('ALLOW');
      }
    }

    const active = signed(newKey.privateKey, fields({ principal_kid: NEW_KID }));
    const fresh = await check({ proof: active.proof });
    expect(fresh.result).toMatchObject({
      ok: true,
      accountId: ACCOUNT,
      principalKid: NEW_KID,
      mandateSource: 'principal_signed',
    });
    expect(fresh.result).not.toHaveProperty('verdict');
    expect(verdictWithPrincipalCheck('BLOCK', fresh.result)).toBe('BLOCK');
    expect(verdictWithPrincipalCheck('UNCERTAIN', fresh.result)).toBe('UNCERTAIN');
    expect(JSON.stringify(fresh.result)).not.toContain('ALLOW');
  });

  it('uses 503 for a manifest account mismatch and BLOCK for a proof account mismatch', async () => {
    const proof = signed(newKey.privateKey, fields());
    const wrongManifest = await check({
      proof: proof.proof,
      document: manifest(OTHER),
    });
    expect(wrongManifest.loads).toEqual([ACCOUNT]);
    expect(wrongManifest.result).toEqual({
      ok: false,
      httpStatus: 503,
      code: 'MANIFEST_MALFORMED',
    });
    expect(classifyWrongAccount('manifest')).toEqual({
      source: 'manifest',
      ok: false,
      httpStatus: 503,
      code: 'MANIFEST_MALFORMED',
    });
    expect(stage4FailureClass('manifest_wrong_account')).toMatchObject({
      class: 'unverifiable',
      httpStatus: 503,
      code: 'MANIFEST_MALFORMED',
    });
    expect(verdictWithPrincipalCheck('ALLOW', wrongManifest.result)).toBe('UNCERTAIN');
    expect(verdictWithPrincipalCheck('BLOCK', wrongManifest.result)).toBe('BLOCK');
    expect(JSON.stringify(wrongManifest.result)).not.toContain('ALLOW');
    expect(JSON.stringify(wrongManifest.result)).not.toContain(OTHER);

    const wrongProof = signed(newKey.privateKey, fields({ account_id: OTHER }));
    const mismatched = await check({ proof: wrongProof.proof, document: manifest(OTHER) });
    expect(mismatched.loads).toEqual([]);
    expect(mismatched.result).toEqual({ ok: false, verdict: 'BLOCK', reason: 'account_mismatch' });
    expect(classifyWrongAccount('proof')).toEqual({
      source: 'proof',
      ok: false,
      verdict: 'BLOCK',
      reason: 'account_mismatch',
    });
    expect(verdictWithPrincipalCheck('ALLOW', mismatched.result)).toBe('BLOCK');
    expect(JSON.stringify(mismatched.result)).not.toContain(OTHER);
  });

  it('keeps registration locked and keeps the stage-3 signature rules', () => {
    let writes = 0;
    const registration = registerPrincipalKey({
      apiKey: LEGACY_KEY,
      agentIdHeader: 'agent42',
      accountId: ACCOUNT,
      manifest: manifest(),
      write: () => {
        writes += 1;
      },
    });
    expect(registration).toEqual({ ok: false, httpStatus: 503, code: 'REGISTRATION_UNAUTHORIZED' });
    expect(writes).toBe(0);
    expect(JSON.stringify(registration)).not.toContain(LEGACY_KEY);

    expect(PRINCIPAL_ENVIRONMENTS).toEqual(['production', 'preview', 'development']);
    expect(PRINCIPAL_MANIFEST_LOAD_DEADLINE_MS).toBe(2_000);
    expect(PRINCIPAL_MANDATE_DOMAIN).toBe('thoughtproof.sentinel.mandate.v1');
    const bytes = principalMandateSignedBytes(MANDATE, fields());
    expect(bytes).not.toBeNull();
    expect(bytes?.subarray(0, Buffer.from(PRINCIPAL_MANDATE_DOMAIN).length).toString('utf8')).toBe(
      PRINCIPAL_MANDATE_DOMAIN,
    );
    expect(bytes?.[Buffer.from(PRINCIPAL_MANDATE_DOMAIN).length]).toBe(0x00);
  });

  it('is not imported by the verify handler or the suite workflow', () => {
    const source = readFileSync(new URL('./mandate-account-migration.ts', import.meta.url), 'utf8');
    const verify = readFileSync(new URL('../api/sentinel/verify.ts', import.meta.url), 'utf8');
    const workflow = readFileSync(
      new URL('../.github/workflows/action-authorization-suite.yml', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('mandate-replay-store');
    expect(source).not.toContain('api/sentinel');
    expect(source).not.toContain('src/engine');
    expect(source).not.toContain('process.env');
    expect(verify).not.toContain('mandate-account-migration');
    expect(workflow).not.toContain('mandate-account-migration');
  });
});
