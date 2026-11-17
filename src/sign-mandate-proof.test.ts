/**
 * Client-side mandate_proof signer. Offline. Key pairs are generated here
 * and are not written into the repo. No network and no provider keys.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeMandate } from './mandate-normalize.js';
import { evaluateMandateRequestPath, type MandateRequestDeps } from './mandate-request-path.js';
import {
  PRINCIPAL_MANDATE_DOMAIN,
  principalMandateSignedBytes,
  verifyPrincipalMandate,
  type PrincipalManifestStore,
  type PrincipalProofFields,
  type PrincipalPublicKey,
} from './principal-key-manifest.js';
import type { MandateReplayCommand } from './mandate-replay-store.js';
import {
  MANDATE_PROOF_SIGN_FAILURE,
  SENTINEL_PRINCIPAL_PRIVATE_KEY_PATH,
  loadEd25519PrivateKeyPem,
  signMandateProof,
  signMandateProofCli,
  type SignedMandateProof,
} from './sign-mandate-proof.js';

const NOW = 1_800_000_000;
const ACCOUNT = 'acct_signer_fixture';
const OTHER = 'acct_other_fixture';
const KID = 'kid-signer-fixture';
const API_KEY = 'sk_signer_fixture_do_not_print';
const REQUEST_ID = 'req_signer_fixture';
const NONCE = 'nonce-signer-fixture-1';

const primary = generateKeyPairSync('ed25519');
const otherKey = generateKeyPairSync('ed25519');

const SCRIPT = fileURLToPath(new URL('../scripts/sign-mandate-proof.ts', import.meta.url));
const REGISTER = fileURLToPath(new URL('../scripts/register-ts-extension.mjs', import.meta.url));

const TRANSFER = {
  kind: 'value_transfer',
  granted: { maxAmount: 1, asset: 'USDC', recipient: 'payee-signer' },
  action: { kind: 'value_transfer', amount: 1, asset: 'USDC', recipient: 'payee-signer' },
};

const ALIASED = {
  kind: 'value_transfer',
  granted: { maxAmountUsd: 1, asset: ' USDC ', recipient: ' payee-signer ' },
  action: { kind: 'value_transfer', amount_usd: 1, asset: 'USDC', recipient: 'payee-signer' },
};

function okpX(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function pem(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function publicPem(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

const PRIMARY_X = okpX(primary.publicKey);
const OTHER_X = okpX(otherKey.publicKey);

function keyEntry(x: string, over: Partial<PrincipalPublicKey> = {}): PrincipalPublicKey {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    x,
    kid: KID,
    status: 'active',
    notBefore: iso(NOW - 1000),
    notAfter: iso(NOW + 10_000),
    ...over,
  };
}

function storeFor(accountId: string, x: string): PrincipalManifestStore {
  return {
    async load(id: string) {
      if (id !== accountId) {
        return { answered: true, manifest: { accountId: id, keys: [] } };
      }
      return {
        answered: true,
        manifest: { accountId, keys: [keyEntry(x)] },
      };
    },
  };
}

function fieldsOf(proof: SignedMandateProof): PrincipalProofFields {
  return {
    schema_version: proof.schema_version,
    nonce: proof.nonce,
    iat: proof.iat,
    exp: proof.exp,
    account_id: proof.account_id,
    environment: proof.environment,
    purpose: proof.purpose,
    principal_kid: proof.principal_kid,
  };
}

function signFor(
  body: unknown,
  over: Partial<Parameters<typeof signMandateProof>[0]> = {},
) {
  return signMandateProof({
    requestBody: body,
    privateKey: primary.privateKey,
    accountId: ACCOUNT,
    principalKid: KID,
    environment: 'production',
    nowSeconds: NOW,
    nonce: NONCE,
    iat: NOW,
    exp: NOW + 60,
    ...over,
  });
}

function consumedReply(exp: number): string {
  return `consumed:${exp + 31}`;
}

function memoryReplay(): MandateReplayCommand & { calls: number } {
  const seen = new Set<string>();
  const command = {
    calls: 0,
    async eval(_script: string, keys: string[], args: string[]) {
      command.calls += 1;
      const key = keys[0] ?? '';
      if (seen.has(key)) return 'block:replay';
      seen.add(key);
      return consumedReply(Number(args[1]));
    },
    async pttl() {
      return 1;
    },
  };
  return command;
}

function deps(over: Partial<MandateRequestDeps> = {}): MandateRequestDeps {
  return {
    nowSeconds: () => NOW,
    readPolicy: () => 'protected',
    manifestStore: storeFor(ACCOUNT, PRIMARY_X),
    replayCommand: memoryReplay(),
    targetEnvironment: 'production',
    env: { SENTINEL_API_KEYS: `${API_KEY}:direct:agent-signer:${ACCOUNT}` },
    ...over,
  };
}

function request(body: unknown, over: Partial<MandateRequestDeps> = {}) {
  return evaluateMandateRequestPath({
    authRequired: true,
    apiKey: API_KEY,
    accountIdFromAuth: undefined,
    agentIdHeader: 'not-the-account',
    body,
    requestId: REQUEST_ID,
    deps: deps(over),
  });
}

function bodyOf(mandate: unknown, proof?: SignedMandateProof, extra: Record<string, unknown> = {}) {
  return {
    claim: 'signer fixture claim',
    evidence: 'signer fixture evidence',
    mode: 'action_authorization',
    mandate,
    ...extra,
    ...(proof ? { mandate_proof: proof } : {}),
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-proof-sign-'));
  tempDirs.push(dir);
  return dir;
}

describe('signMandateProof', () => {
  it('round-trips through the request-path verifier', async () => {
    const signed = signFor(bodyOf(TRANSFER));
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const proof = signed.mandate_proof;
    expect(proof.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(proof).not.toHaveProperty('d');
    expect(Object.keys(proof).sort()).toEqual([
      'account_id',
      'environment',
      'exp',
      'iat',
      'nonce',
      'principal_kid',
      'purpose',
      'schema_version',
      'signature',
    ]);

    const normalization = normalizeMandate(TRANSFER);
    expect(normalization.ok).toBe(true);
    if (!normalization.ok) return;
    const bytes = principalMandateSignedBytes(normalization.mandate, fieldsOf(proof));
    expect(bytes).not.toBeNull();
    expect(bytes?.subarray(0, Buffer.from(PRINCIPAL_MANDATE_DOMAIN).length).toString('utf8')).toBe(
      PRINCIPAL_MANDATE_DOMAIN,
    );
    expect(bytes?.[Buffer.from(PRINCIPAL_MANDATE_DOMAIN).length]).toBe(0x00);
    expect(verify(null, bytes as Buffer, primary.publicKey, Buffer.from(proof.signature, 'hex'))).toBe(true);

    const direct = await verifyPrincipalMandate({
      authenticatedAccountId: ACCOUNT,
      mandate: normalization.mandate,
      mandateProof: proof,
      nowSeconds: NOW,
      store: storeFor(ACCOUNT, PRIMARY_X),
      targetEnvironment: 'production',
    });
    expect(direct).toEqual({
      ok: true,
      accountId: ACCOUNT,
      principalKid: KID,
      mandateSource: 'principal_signed',
    });
    expect(JSON.stringify(direct)).not.toContain('ALLOW');

    const replay = memoryReplay();
    const decision = await request(bodyOf(TRANSFER, proof), { replayCommand: replay });
    expect(decision.action).toBe('continue');
    if (decision.action === 'continue') {
      expect(decision.verified?.mandateSource).toBe('principal_signed');
      expect(decision.verified?.normalizedMandate).toEqual(normalization.mandate);
    }
    expect(replay.calls).toBe(1);
    expect(JSON.stringify(decision)).not.toContain('ALLOW');
    expect(JSON.stringify(decision)).not.toContain(pem(primary.privateKey));
  });

  it('signs the normalized mandate, so an aliased body still verifies', async () => {
    const signed = signFor(bodyOf(ALIASED));
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const normalization = normalizeMandate(ALIASED);
    const canonical = normalizeMandate(TRANSFER);
    expect(normalization.ok && canonical.ok).toBe(true);
    if (!normalization.ok || !canonical.ok) return;
    expect(normalization.mandate).toEqual(canonical.mandate);

    const proofFields = fieldsOf(signed.mandate_proof);
    const normalizedBytes = principalMandateSignedBytes(normalization.mandate, proofFields);
    const rawBytes = principalMandateSignedBytes(ALIASED, proofFields);
    expect(normalizedBytes?.equals(rawBytes as Buffer)).toBe(false);
    expect(verify(
      null,
      normalizedBytes as Buffer,
      primary.publicKey,
      Buffer.from(signed.mandate_proof.signature, 'hex'),
    )).toBe(true);
    expect(verify(
      null,
      rawBytes as Buffer,
      primary.publicKey,
      Buffer.from(signed.mandate_proof.signature, 'hex'),
    )).toBe(false);

    const decision = await request(bodyOf(ALIASED, signed.mandate_proof));
    expect(decision.action).toBe('continue');
  });

  it('rejects a tampered body, a wrong key, an expired proof, a reused nonce, and the wrong account', async () => {
    const signed = signFor(bodyOf(TRANSFER));
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const proof = signed.mandate_proof;

    const tamperedMandate = {
      ...TRANSFER,
      action: { ...TRANSFER.action, amount: 2 },
    };
    const tamperReplay = memoryReplay();
    const tampered = await request(bodyOf(tamperedMandate, proof), { replayCommand: tamperReplay });
    expect(tampered.action).toBe('block');
    if (tampered.action === 'block') expect(tampered.body.reason).toBe('signature_invalid');
    expect(tamperReplay.calls).toBe(0);

    const wrongKeyReplay = memoryReplay();
    const wrongKey = await request(bodyOf(TRANSFER, proof), {
      manifestStore: storeFor(ACCOUNT, OTHER_X),
      replayCommand: wrongKeyReplay,
    });
    expect(wrongKey.action).toBe('block');
    if (wrongKey.action === 'block') expect(wrongKey.body.reason).toBe('signature_invalid');
    expect(wrongKeyReplay.calls).toBe(0);

    const expiredReplay = memoryReplay();
    const expired = await request(bodyOf(TRANSFER, proof), {
      nowSeconds: () => proof.exp + 31,
      replayCommand: expiredReplay,
    });
    expect(expired.action).toBe('block');
    if (expired.action === 'block') expect(expired.body.reason).toBe('expired');
    expect(expiredReplay.calls).toBe(0);

    const replay = memoryReplay();
    const first = await request(bodyOf(TRANSFER, proof), { replayCommand: replay });
    const second = await request(bodyOf(TRANSFER, proof), { replayCommand: replay });
    expect(first.action).toBe('continue');
    expect(second.action).toBe('block');
    if (second.action === 'block') expect(second.body.reason).toBe('replay');
    expect(replay.calls).toBe(2);

    const otherReplay = memoryReplay();
    const wrongAccount = await request(bodyOf(TRANSFER, proof), {
      env: { SENTINEL_API_KEYS: `${API_KEY}:direct:agent-signer:${OTHER}` },
      manifestStore: storeFor(OTHER, PRIMARY_X),
      replayCommand: otherReplay,
    });
    expect(wrongAccount.action).toBe('block');
    if (wrongAccount.action === 'block') expect(wrongAccount.body.reason).toBe('account_mismatch');
    expect(otherReplay.calls).toBe(0);
    expect(JSON.stringify(wrongAccount)).not.toContain(PRIMARY_X);
    expect(JSON.stringify(wrongAccount)).not.toContain('ALLOW');
  });

  it('does not bind claim or evidence, and fails closed without emitting a proof', () => {
    const signed = signFor(bodyOf(TRANSFER));
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const same = signFor({ ...bodyOf(TRANSFER), claim: 'different claim', evidence: 'different evidence' });
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(same.mandate_proof.signature).toBe(signed.mandate_proof.signature);

    const closed = [
      signFor({ claim: 'no mandate' }),
      signFor(bodyOf({})),
      signFor(bodyOf(TRANSFER), { environment: 'staging' }),
      signFor(bodyOf(TRANSFER), { accountId: ' ' }),
      signFor(bodyOf(TRANSFER), { principalKid: ' kid' }),
      signFor(bodyOf(TRANSFER), { nonce: 'short' }),
      signFor(bodyOf(TRANSFER), { iat: NOW, exp: NOW }),
      signFor(bodyOf(TRANSFER), { iat: NOW, exp: NOW + 301 }),
      signFor(bodyOf(TRANSFER), { nowSeconds: NOW + 10_000 }),
      signFor(bodyOf(TRANSFER), { privateKey: primary.publicKey }),
    ];
    for (const result of closed) {
      expect(result).toEqual({ ok: false });
      expect(result).not.toHaveProperty('mandate_proof');
    }

    expect(loadEd25519PrivateKeyPem(pem(primary.privateKey))?.asymmetricKeyType).toBe('ed25519');
    expect(loadEd25519PrivateKeyPem(publicPem(primary.publicKey))).toBeNull();
    expect(loadEd25519PrivateKeyPem('not a key')).toBeNull();
    expect(loadEd25519PrivateKeyPem('')).toBeNull();
  });
});

describe('sign-mandate-proof CLI', () => {
  function run(args: string[], env: Record<string, string>) {
    return spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--import',
        REGISTER,
        SCRIPT,
        ...args,
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } },
    );
  }

  it('prints one proof and does not print the private key', async () => {
    const dir = tempDir();
    const keyPath = join(dir, 'principal.pem');
    const bodyPath = join(dir, 'request.json');
    const privatePem = pem(primary.privateKey);
    writeFileSync(keyPath, privatePem);
    writeFileSync(bodyPath, JSON.stringify(bodyOf(TRANSFER)));
    const ran = run(
      [
        '--body', bodyPath,
        '--account-id', ACCOUNT,
        '--kid', KID,
        '--environment', 'production',
        '--nonce', NONCE,
        '--iat', String(NOW),
        '--exp', String(NOW + 60),
        '--now', String(NOW),
      ],
      { [SENTINEL_PRINCIPAL_PRIVATE_KEY_PATH]: keyPath },
    );
    expect(ran.status).toBe(0);
    expect(ran.stderr).not.toContain(MANDATE_PROOF_SIGN_FAILURE);
    expect(ran.stdout).not.toContain('BEGIN PRIVATE KEY');
    expect(ran.stderr).not.toContain('BEGIN PRIVATE KEY');
    expect(ran.stdout).not.toContain(privatePem);
    expect(ran.stderr).not.toContain(privatePem);
    const proof = JSON.parse(ran.stdout) as SignedMandateProof;
    expect(proof.principal_kid).toBe(KID);
    expect(proof.account_id).toBe(ACCOUNT);
    expect(proof.nonce).toBe(NONCE);
    const decision = await request(bodyOf(TRANSFER, proof));
    expect(decision.action).toBe('continue');
  });

  it('fails closed with no proof on a bad key, a bad body, or a leaked argument', () => {
    const dir = tempDir();
    const publicPath = join(dir, 'public.pem');
    const bodyPath = join(dir, 'request.json');
    const privatePem = pem(primary.privateKey);
    const canary = 'CANARY_PRIVATE_ARGUMENT_DO_NOT_PRINT';
    writeFileSync(publicPath, publicPem(primary.publicKey));
    writeFileSync(bodyPath, JSON.stringify(bodyOf(TRANSFER)));

    const missing = signMandateProofCli({
      argv: ['--body', bodyPath, '--account-id', ACCOUNT, '--kid', KID, '--environment', 'production'],
      env: {},
      stdout: { write() {} },
      stderr: { write() {} },
    });
    expect(missing).toBe(2);

    const captured: { out: string; err: string } = { out: '', err: '' };
    const code = signMandateProofCli({
      argv: [
        '--body', bodyPath,
        '--account-id', ACCOUNT,
        '--kid', KID,
        '--environment', 'production',
        '--now', String(NOW),
        canary,
      ],
      env: { [SENTINEL_PRINCIPAL_PRIVATE_KEY_PATH]: publicPath },
      stdout: { write(chunk) { captured.out += chunk; } },
      stderr: { write(chunk) { captured.err += chunk; } },
    });
    expect(code).toBe(2);
    expect(captured.out).toBe('');
    expect(captured.err).toBe(`${MANDATE_PROOF_SIGN_FAILURE}\n`);
    expect(captured.err).not.toContain(canary);
    expect(captured.out).not.toContain(canary);
    expect(captured.err).not.toContain('BEGIN PUBLIC KEY');

    const ran = run(
      ['--body', bodyPath, '--account-id', ACCOUNT, '--kid', KID, '--environment', 'production', canary],
      { [SENTINEL_PRINCIPAL_PRIVATE_KEY_PATH]: join(dir, 'missing.pem') },
    );
    expect(ran.status).toBe(2);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toBe(`${MANDATE_PROOF_SIGN_FAILURE}\n`);
    expect(ran.stdout).not.toContain(privatePem);
    expect(ran.stderr).not.toContain(canary);
    expect(ran.stderr).not.toContain(privatePem);

    const badBody = join(dir, 'bad.json');
    writeFileSync(badBody, '{');
    const bad = run(
      [
        '--body', badBody,
        '--account-id', ACCOUNT,
        '--kid', KID,
        '--environment', 'production',
        '--now', String(NOW),
      ],
      { [SENTINEL_PRINCIPAL_PRIVATE_KEY_PATH]: publicPath },
    );
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe('');
    expect(bad.stdout).not.toContain('signature');
  });

  it('does not set the enforce flag or print key material from the module', () => {
    const source = readFileSync(new URL('./sign-mandate-proof.ts', import.meta.url), 'utf8');
    const cli = readFileSync(new URL('../scripts/sign-mandate-proof.ts', import.meta.url), 'utf8');
    expect(source).toContain('principalMandateSignedBytes');
    expect(source).toContain('normalizeMandate');
    expect(source).not.toContain('console.log');
    expect(cli).not.toContain('console.log');
    expect(source).not.toContain('SENTINEL_MANDATE_PROOF_ENFORCE');
    expect(cli).not.toContain('SENTINEL_MANDATE_PROOF_ENFORCE');
    expect(source).not.toContain('registerPrincipalKey');
    expect(cli).not.toContain('[skip ci]');
  });
});
