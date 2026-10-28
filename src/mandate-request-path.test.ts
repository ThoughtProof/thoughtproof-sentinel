/**
 * ADR-0023 stage-4 request-path wiring. Offline. No network and no provider keys.
 * Key material is generated in this file and is not written to the repo.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MANDATE_PROOF_ENFORCE_ENV,
  evaluateMandateRequestPath,
  mandateProofEnforceEnabled,
  verdictAfterVerifiedMandate,
  type MandateRequestDeps,
  type MandateVerifiedContinuation,
} from './mandate-request-path.js';
import { normalizeMandate } from './mandate-normalize.js';
import { MANDATE_VERIFICATION_UNAVAILABLE_MESSAGE } from './mandate-no-auth.js';
import {
  PRINCIPAL_MANDATE_PURPOSE,
  PRINCIPAL_MANDATE_SCHEMA,
  principalMandateSignedBytes,
  type PrincipalKeyManifest,
  type PrincipalManifestStore,
  type PrincipalProofFields,
  type PrincipalPublicKey,
} from './principal-key-manifest.js';
import type { MandateReplayCommand } from './mandate-replay-store.js';

const NOW = 1_800_000_000;
const ACCOUNT = 'acct-wire';
const OTHER = 'acct-other';
const KID = 'kid-wire';
const API_KEY = 'wire-fixture-key';
const REQUEST_ID = 'req_wire_fixture';

const primary = generateKeyPairSync('ed25519');
const otherKey = generateKeyPairSync('ed25519');

function okpX(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

const PRIMARY_X = okpX(primary.publicKey);
const OTHER_X = okpX(otherKey.publicKey);

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const TRANSFER = {
  kind: 'value_transfer',
  granted: { maxAmount: 1, asset: 'USDC', recipient: 'payee-wire' },
  action: { kind: 'value_transfer', amount: 1, asset: 'USDC', recipient: 'payee-wire' },
};

function fields(over: Partial<PrincipalProofFields> = {}): PrincipalProofFields {
  return {
    schema_version: PRINCIPAL_MANDATE_SCHEMA,
    nonce: 'nonce-wire-1',
    iat: NOW,
    exp: NOW + 60,
    account_id: ACCOUNT,
    environment: 'production',
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

function manifest(keys: PrincipalPublicKey[] = [keyEntry()]): PrincipalKeyManifest {
  return { accountId: ACCOUNT, keys };
}

function signedProof(
  proofFields: PrincipalProofFields,
  mandate: unknown,
  privateKey: KeyObject = primary.privateKey,
): PrincipalProofFields & { signature: string } {
  const bytes = principalMandateSignedBytes(mandate, proofFields);
  if (!bytes) throw new Error('fixture bytes were not produced');
  return { ...proofFields, signature: sign(null, bytes, privateKey).toString('hex') };
}

function countingStore(manifestValue: unknown = manifest()): PrincipalManifestStore & { loads: number } {
  const store = {
    loads: 0,
    async load(accountId: string) {
      store.loads += 1;
      if (accountId !== ACCOUNT) return { answered: true as const, manifest: { accountId, keys: [] } };
      return { answered: true as const, manifest: manifestValue };
    },
  };
  return store;
}

function scriptedReplay(reply: unknown): MandateReplayCommand & { calls: number } {
  const command = {
    calls: 0,
    async eval() {
      command.calls += 1;
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async pttl() {
      return 1;
    },
  };
  return command;
}

function consumedReply(exp = NOW + 60): string {
  return `consumed:${exp + 30 + 1}`;
}

function deps(over: Partial<MandateRequestDeps> = {}): MandateRequestDeps {
  return {
    nowSeconds: () => NOW,
    readPolicy: () => 'protected',
    manifestStore: countingStore(),
    replayCommand: scriptedReplay(consumedReply()),
    targetEnvironment: 'production',
    env: { SENTINEL_API_KEYS: `${API_KEY}:direct:agent-wire:${ACCOUNT}` },
    ...over,
  };
}

function bodyOf(mandate: unknown, proof: unknown): Record<string, unknown> {
  return {
    claim: 'wire',
    evidence: 'wire',
    mode: 'action_authorization',
    mandate,
    mandate_proof: proof,
  };
}

async function evaluate(
  body: unknown,
  over: Partial<MandateRequestDeps> = {},
  input: { authRequired?: boolean; apiKey?: string; accountIdFromAuth?: string } = {},
) {
  return evaluateMandateRequestPath({
    authRequired: input.authRequired ?? true,
    apiKey: input.apiKey ?? API_KEY,
    accountIdFromAuth: input.accountIdFromAuth,
    agentIdHeader: 'not-the-account',
    body,
    requestId: REQUEST_ID,
    deps: deps(over),
  });
}

function normalizedTransfer() {
  const normalization = normalizeMandate(TRANSFER);
  if (!normalization.ok) throw new Error('fixture mandate did not normalize');
  return normalization;
}

describe('mandate proof enforcement flag', () => {
  it('is off unless the env value is exactly true', () => {
    expect(mandateProofEnforceEnabled({})).toBe(false);
    expect(mandateProofEnforceEnabled({ [MANDATE_PROOF_ENFORCE_ENV]: undefined })).toBe(false);
    for (const value of ['', 'false', '0', 'TRUE', 'True', 'yes', 'on', '1']) {
      expect(mandateProofEnforceEnabled({ [MANDATE_PROOF_ENFORCE_ENV]: value })).toBe(false);
    }
    expect(mandateProofEnforceEnabled({ [MANDATE_PROOF_ENFORCE_ENV]: 'true' })).toBe(true);
  });
});

describe('evaluateMandateRequestPath', () => {
  it('accepts a valid proof and does not turn it into ALLOW', async () => {
    const normalization = normalizedTransfer();
    const proof = signedProof(fields(), normalization.mandate);
    const replay = scriptedReplay(consumedReply());
    const decision = await evaluate(bodyOf(TRANSFER, proof), { replayCommand: replay });
    expect(decision.action).toBe('continue');
    if (decision.action !== 'continue' || !decision.verified) {
      throw new Error('expected a verified continuation');
    }
    expect(decision.verified.mandateSource).toBe('principal_signed');
    expect(decision.verified.normalizedMandate.kind).toBe('value_transfer');
    expect(decision.verified.normalizedMandate.action.kind).toBe('value_transfer');
    expect(decision).not.toHaveProperty('verdict');
    expect(JSON.stringify(decision)).not.toContain('ALLOW');
    expect(JSON.stringify(decision)).not.toContain(proof.signature);
    expect(JSON.stringify(decision)).not.toContain(PRIMARY_X);
    expect(replay.calls).toBe(1);

    const verified: MandateVerifiedContinuation = decision.verified;
    expect(verdictAfterVerifiedMandate('ALLOW', verified)).toBe('ALLOW');
    expect(verdictAfterVerifiedMandate('BLOCK', verified)).toBe('BLOCK');
    expect(verdictAfterVerifiedMandate('UNCERTAIN', verified)).toBe('UNCERTAIN');
  });

  it('keeps mandate kind and action kind separate', async () => {
    const raw = {
      kind: 'value_transfer',
      granted: { maxAmount: 5, asset: 'USDC', recipient: 'spender-wire' },
      action: {
        kind: 'permission',
        allowance: '2',
        asset: 'USDC',
        recipient: 'spender-wire',
      },
    };
    const normalization = normalizeMandate(raw);
    expect(normalization.ok).toBe(true);
    if (!normalization.ok) return;
    expect(normalization.mandate.kind).toBe('value_transfer');
    expect(normalization.mandate.action.kind).toBe('permission');
    const proof = signedProof(fields({ nonce: 'nonce-kinds' }), normalization.mandate);
    const decision = await evaluate(bodyOf(raw, proof), {
      replayCommand: scriptedReplay(consumedReply()),
    });
    expect(decision.action).toBe('continue');
    if (decision.action === 'continue' && decision.verified) {
      expect(decision.verified.normalizedMandate.kind).not.toBe(
        decision.verified.normalizedMandate.action.kind,
      );
    }
  });

  it('blocks a malformed signature before the manifest store', async () => {
    const normalization = normalizedTransfer();
    const proof = signedProof(fields(), normalization.mandate);
    const store = countingStore();
    const replay = scriptedReplay(consumedReply());
    for (const signature of [`0x${proof.signature}`, proof.signature.toUpperCase(), 'abcd', '', 'zz']) {
      const decision = await evaluate(bodyOf(TRANSFER, { ...proof, signature }), {
        manifestStore: store,
        replayCommand: replay,
      });
      expect(decision).toEqual({
        action: 'block',
        status: 200,
        body: {
          verdict: 'BLOCK',
          code: 'MANDATE_PROOF_INVALID',
          reason: 'malformed_signature',
          request_id: REQUEST_ID,
        },
      });
    }
    expect(store.loads).toBe(0);
    expect(replay.calls).toBe(0);
  });

  it('blocks an invalid signature and a wrong kid without consuming a nonce', async () => {
    const normalization = normalizedTransfer();
    const good = signedProof(fields(), normalization.mandate);
    const wrongKey = signedProof(fields(), normalization.mandate, otherKey.privateKey);
    const store = countingStore();
    const replay = scriptedReplay(consumedReply());
    const invalid = await evaluate(bodyOf(TRANSFER, wrongKey), {
      manifestStore: store,
      replayCommand: replay,
    });
    expect(invalid.action).toBe('block');
    if (invalid.action === 'block') expect(invalid.body.reason).toBe('signature_invalid');

    const wrongKid = await evaluate(
      bodyOf(TRANSFER, signedProof(fields({ principal_kid: 'kid-missing' }), normalization.mandate)),
      { manifestStore: store, replayCommand: replay },
    );
    expect(wrongKid.action).toBe('block');
    if (wrongKid.action === 'block') expect(wrongKid.body.reason).toBe('unknown_kid');
    expect(replay.calls).toBe(0);
    expect(JSON.stringify(invalid)).not.toContain(good.signature);
    expect(JSON.stringify(wrongKid)).not.toContain(PRIMARY_X);
  });

  it('treats a revoked kid as terminal', async () => {
    const normalization = normalizedTransfer();
    const proof = signedProof(fields(), normalization.mandate);
    const replay = scriptedReplay(consumedReply());
    const decision = await evaluate(bodyOf(TRANSFER, proof), {
      manifestStore: countingStore(manifest([keyEntry({ status: 'revoked' })])),
      replayCommand: replay,
    });
    expect(decision.action).toBe('block');
    if (decision.action === 'block') {
      expect(decision.body.verdict).toBe('BLOCK');
      expect(decision.body.reason).toBe('revoked');
    }
    expect(replay.calls).toBe(0);
    expect(JSON.stringify(decision)).not.toContain('ALLOW');
  });

  it('blocks a replay and does not continue', async () => {
    const normalization = normalizedTransfer();
    const proof = signedProof(fields({ nonce: 'nonce-replay' }), normalization.mandate);
    const seen = new Set<string>();
    const replay: MandateReplayCommand & { calls: number } = {
      calls: 0,
      async eval(_script, keys) {
        replay.calls += 1;
        const key = keys[0] ?? '';
        if (seen.has(key)) return 'block:replay';
        seen.add(key);
        return consumedReply();
      },
      async pttl() {
        return 1;
      },
    };
    const first = await evaluate(bodyOf(TRANSFER, proof), { replayCommand: replay });
    const second = await evaluate(bodyOf(TRANSFER, proof), { replayCommand: replay });
    expect(first.action).toBe('continue');
    expect(second.action).toBe('block');
    if (second.action === 'block') expect(second.body.reason).toBe('replay');
    expect(replay.calls).toBe(2);
  });

  it('returns 503 when the manifest or the replay store does not answer', async () => {
    const normalization = normalizedTransfer();
    const proof = signedProof(fields(), normalization.mandate);
    const replay = scriptedReplay(consumedReply());
    const downStore: PrincipalManifestStore = {
      async load() {
        throw new Error('manifest password leaked');
      },
    };
    const manifestDown = await evaluate(bodyOf(TRANSFER, proof), {
      manifestStore: downStore,
      replayCommand: replay,
    });
    expect(manifestDown.action).toBe('unavailable');
    if (manifestDown.action === 'unavailable') {
      expect(manifestDown.status).toBe(503);
      expect(manifestDown.body).toEqual({
        error: MANDATE_VERIFICATION_UNAVAILABLE_MESSAGE,
        code: 'MANIFEST_UNAVAILABLE',
        request_id: REQUEST_ID,
      });
      expect(manifestDown.body).not.toHaveProperty('verdict');
      expect(JSON.stringify(manifestDown.body)).not.toContain('leaked');
      expect(JSON.stringify(manifestDown.body)).not.toContain(proof.signature);
    }
    expect(replay.calls).toBe(0);

    const replayDown = await evaluate(bodyOf(TRANSFER, proof), {
      replayCommand: scriptedReplay(new Error('redis token leaked')),
    });
    expect(replayDown.action).toBe('unavailable');
    if (replayDown.action === 'unavailable') {
      expect(replayDown.body).toEqual({
        error: MANDATE_VERIFICATION_UNAVAILABLE_MESSAGE,
        code: 'REPLAY_STORE_UNAVAILABLE',
        request_id: REQUEST_ID,
      });
      expect(replayDown.body).not.toHaveProperty('verdict');
      expect(JSON.stringify(replayDown.body)).not.toContain('leaked');
      expect(JSON.stringify(replayDown.body)).not.toContain('ALLOW');
    }
  });

  it('does not run the strict normalizer for a legacy call without a proof', async () => {
    let normalizerCalls = 0;
    const decision = await evaluate(
      {
        claim: 'FYI',
        evidence: 'status',
        mode: 'action_authorization',
        mandate: {
          kind: 'informational',
          action: { kind: 'informational', content: 'status ping secret' },
        },
      },
      {
        readPolicy: () => 'legacy',
        normalize: () => {
          normalizerCalls += 1;
          return { ok: false, verdict: 'BLOCK', reason: 'malformed' };
        },
      },
    );
    expect(decision).toEqual({ action: 'continue' });
    expect(normalizerCalls).toBe(0);
    expect(JSON.stringify(decision)).not.toContain('status ping secret');
    expect(JSON.stringify(decision)).not.toContain('principal_signed');
  });

  it('requires a proof on a protected account and does not invent a recipient', async () => {
    const decision = await evaluate(
      {
        mandate: {
          kind: 'informational',
          action: { kind: 'informational', content: 'status ping secret' },
        },
      },
      { readPolicy: () => 'protected' },
    );
    expect(decision.action).toBe('block');
    if (decision.action === 'block') {
      expect(decision.body.verdict).toBe('BLOCK');
      expect(decision.body.reason).toBe('mandate_proof_required');
      expect(JSON.stringify(decision.body)).not.toContain('status ping secret');
      expect(JSON.stringify(decision.body)).not.toContain('recipient');
    }
  });

  it('binds an explicit proof on a legacy account, including a missing recipient', async () => {
    let normalizerCalls = 0;
    const mandate = {
      kind: 'informational',
      action: { kind: 'informational', content: 'status ping secret' },
    };
    const decision = await evaluate(bodyOf(mandate, { signature: 'ab' }), {
      readPolicy: () => 'legacy',
      normalize: (input) => {
        normalizerCalls += 1;
        return normalizeMandate(input);
      },
    });
    expect(normalizerCalls).toBe(1);
    expect(decision.action).toBe('block');
    if (decision.action === 'block') {
      expect(decision.body.verdict).toBe('BLOCK');
      expect(decision.body.reason).not.toBe('mandate_proof_required');
      expect(JSON.stringify(decision.body)).not.toContain('status ping secret');
    }
  });

  it('blocks malformed financial fields and a non-finite allowance', async () => {
    const cases = [
      {
        kind: 'permission',
        action: { kind: 'permission', allowance: '1e2', asset: 'USDC', recipient: 'spender-wire' },
      },
      {
        kind: 'permission',
        action: {
          kind: 'permission',
          allowance: '9'.repeat(309),
          asset: 'USDC',
          recipient: 'spender-wire',
        },
      },
    ];
    for (const mandate of cases) {
      const normalization = normalizeMandate(mandate);
      expect(normalization.ok).toBe(false);
      const proof = {
        ...fields(),
        signature: 'a'.repeat(128),
      };
      const decision = await evaluate(bodyOf(mandate, proof));
      expect(decision.action).toBe('block');
      if (decision.action === 'block') {
        expect(decision.body.verdict).toBe('BLOCK');
        expect(decision.body.reason).toBe('malformed');
      }
      expect(JSON.stringify(decision)).not.toContain('ALLOW');
    }
  });

  it('fails closed in no-auth mode, including a whitespace account id', async () => {
    const normalization = normalizedTransfer();
    const proof = signedProof(fields(), normalization.mandate);
    const present = await evaluate(bodyOf(TRANSFER, proof), {}, { authRequired: false });
    expect(present.action).toBe('unavailable');
    if (present.action === 'unavailable') {
      expect(present.body).toEqual({
        error: MANDATE_VERIFICATION_UNAVAILABLE_MESSAGE,
        code: 'ACCOUNT_UNAVAILABLE',
        request_id: REQUEST_ID,
      });
      expect(present.body).not.toHaveProperty('verdict');
    }

    for (const accountIdFromAuth of [' ', '   ', '\n', '\t', ' \t ']) {
      const decision = await evaluate(bodyOf(TRANSFER, proof), {}, {
        authRequired: false,
        accountIdFromAuth,
      });
      expect(decision.action).toBe('unavailable');
      if (decision.action === 'unavailable') {
        expect(decision.body.code).toBe('ACCOUNT_UNAVAILABLE');
        expect(decision.body).not.toHaveProperty('verdict');
      }
    }
  });

  it('returns 503 for a pre-account key and does not replace an unknown key with 503', async () => {
    const pre = await evaluate(
      { claim: 'x', evidence: 'y', mode: 'handoff' },
      {
        readPolicy: () => 'legacy',
        env: { SENTINEL_API_KEYS: `${API_KEY}:direct:agent-wire` },
      },
    );
    expect(pre.action).toBe('unavailable');
    if (pre.action === 'unavailable') {
      expect(pre.body.code).toBe('ACCOUNT_UNAVAILABLE');
      expect(JSON.stringify(pre.body)).not.toContain(API_KEY);
      expect(pre.body).not.toHaveProperty('verdict');
    }

    const unknown = await evaluate(
      { claim: 'x', evidence: 'y', mode: 'handoff' },
      { env: { SENTINEL_API_KEYS: `${API_KEY}:direct:agent-wire:${ACCOUNT}` } },
      { apiKey: 'wire-not-in-the-list' },
    );
    expect(unknown).toEqual({ action: 'unauthorized' });
    expect(JSON.stringify(unknown)).not.toContain('ACCOUNT_UNAVAILABLE');
    expect(JSON.stringify(unknown)).not.toContain('ALLOW');
  });

  it('does not continue when policy is unreadable, and does not spend the nonce', async () => {
    const normalization = normalizedTransfer();
    const proof = signedProof(fields({ nonce: 'nonce-policy' }), normalization.mandate);
    const replay = scriptedReplay(consumedReply());
    const decision = await evaluate(bodyOf(TRANSFER, proof), {
      readPolicy: () => 'unreadable',
      replayCommand: replay,
    });
    expect(decision.action).toBe('unavailable');
    if (decision.action === 'unavailable') {
      expect(decision.body.code).toBe('POLICY_UNAVAILABLE');
      expect(decision.body.error).toBe(MANDATE_VERIFICATION_UNAVAILABLE_MESSAGE);
      expect(decision.body).not.toHaveProperty('verdict');
    }
    expect(replay.calls).toBe(0);
  });

  it('blocks a proof account id that does not equal the server account', async () => {
    const normalization = normalizedTransfer();
    const proof = signedProof(fields({ account_id: OTHER }), normalization.mandate);
    const replay = scriptedReplay(consumedReply());
    const decision = await evaluate(bodyOf(TRANSFER, proof), { replayCommand: replay });
    expect(decision.action).toBe('block');
    if (decision.action === 'block') expect(decision.body.reason).toBe('account_mismatch');
    expect(replay.calls).toBe(0);
    expect(JSON.stringify(decision)).not.toContain(OTHER);
  });

  it('stays off the paid-suite trigger paths and does not register a key', () => {
    const source = readFileSync(new URL('./mandate-request-path.ts', import.meta.url), 'utf8');
    const verify = readFileSync(new URL('../api/sentinel/verify.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('registerPrincipalKey');
    expect(source).not.toContain('src/engine');
    expect(source).not.toContain('console.');
    expect(verify).toContain('mandate-request-path');
    expect(verify).toContain('mandateProofEnforceEnabled');
    expect(verify).not.toContain('registerPrincipalKey');
    const forbidden = [
      'src/engine/index.ts',
      'scenarios/action-authorization-suite.json',
      'scripts/action-authorization-suite.mjs',
      'scripts/lib/action-auth-suite-metrics.mjs',
      'scripts/lib/action-auth-suite-receipt.mjs',
      '.github/workflows/action-authorization-suite.yml',
    ];
    for (const file of forbidden) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(text).not.toContain('mandate-request-path');
      expect(text).not.toContain('SENTINEL_MANDATE_PROOF_ENFORCE');
    }
  });
});
