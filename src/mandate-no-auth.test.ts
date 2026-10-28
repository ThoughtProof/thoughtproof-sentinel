/**
 * Offline no-auth mandate path. Env fixtures only. No network and no provider keys.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { validateApiKey } from './auth.js';
import { verdictWithMandateNormalization, normalizeMandate } from './mandate-normalize.js';
import {
  decideNoAuthMandatePath,
  stage4FailureClass,
  type Stage4FailureKind,
} from './mandate-no-auth.js';
import { verdictWithPrincipalCheck } from './principal-key-manifest.js';
import { resolveServerAccountId } from './server-account.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const FLAGS = [
  { mandateProofPresent: false, signatureVerified: false, concreteAction: false },
  { mandateProofPresent: true, signatureVerified: false, concreteAction: false },
  { mandateProofPresent: true, signatureVerified: true, concreteAction: false },
  { mandateProofPresent: true, signatureVerified: true, concreteAction: true },
  { mandateProofPresent: false, signatureVerified: true, concreteAction: true },
];

describe('no-auth mandate path', () => {
  it('fails closed with 503 when no account id exists, for every proof shape', () => {
    for (const flags of FLAGS) {
      const decision = decideNoAuthMandatePath({
        authenticatedAccountId: undefined,
        ...flags,
      });
      expect(decision).toEqual({
        applies: true,
        ok: false,
        httpStatus: 503,
        code: 'ACCOUNT_UNAVAILABLE',
      });
      if (decision.applies) {
        expect(verdictWithPrincipalCheck('ALLOW', decision)).toBe('UNCERTAIN');
        expect(verdictWithPrincipalCheck('UNCERTAIN', decision)).toBe('UNCERTAIN');
        expect(verdictWithPrincipalCheck('BLOCK', decision)).toBe('BLOCK');
      }
      expect(decision).not.toHaveProperty('verdict');
      expect(JSON.stringify(decision)).not.toContain('ALLOW');

      const blank = decideNoAuthMandatePath({ authenticatedAccountId: '', ...flags });
      expect(blank).toEqual(decision);
    }
  });

  it('does not authorize when an account id is already present', () => {
    for (const flags of FLAGS) {
      const decision = decideNoAuthMandatePath({
        authenticatedAccountId: 'acct-present',
        ...flags,
      });
      expect(decision).toEqual({ applies: false, authorizesExecution: false });
      expect(decision).not.toHaveProperty('verdict');
      expect(decision).not.toHaveProperty('ok');
      expect(JSON.stringify(decision)).not.toContain('ALLOW');
      expect(JSON.stringify(decision)).not.toContain('acct-present');
    }
  });

  it('follows validateApiKey when auth is not required and does not invent an account', () => {
    delete process.env.SENTINEL_AUTH_REQUIRED;
    process.env.SENTINEL_API_KEYS = 'sk_fixture:openserv:agent42:acct-from-record';
    const open = validateApiKey('sk_fixture');
    expect(open).toEqual({ valid: true });
    expect(open.accountId).toBeUndefined();
    const decision = decideNoAuthMandatePath({
      authenticatedAccountId: open.accountId,
      mandateProofPresent: true,
      signatureVerified: true,
      concreteAction: true,
    });
    expect(decision).toEqual({
      applies: true,
      ok: false,
      httpStatus: 503,
      code: 'ACCOUNT_UNAVAILABLE',
    });
    if (decision.applies) expect(verdictWithPrincipalCheck('ALLOW', decision)).toBe('UNCERTAIN');

    process.env.SENTINEL_AUTH_REQUIRED = 'false';
    expect(validateApiKey(undefined)).toEqual({ valid: true });
    expect(validateApiKey(undefined).accountId).toBeUndefined();
  });

  it('keeps a pre-account key and a bad key out of the mandate ALLOW path', () => {
    process.env.SENTINEL_AUTH_REQUIRED = 'true';
    process.env.SENTINEL_API_KEYS = 'sk_fixture:openserv:agent42';
    const pre = validateApiKey('sk_fixture');
    expect(pre.valid).toBe(true);
    expect(pre.agent_id).toBe('agent42');
    expect(pre.accountId).toBeUndefined();
    const resolved = resolveServerAccountId({
      apiKey: 'sk_fixture',
      agentIdHeader: 'agent42',
      requestAccountId: 'spoofed',
      env: { SENTINEL_API_KEYS: process.env.SENTINEL_API_KEYS },
    });
    expect(resolved).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });
    const decision = decideNoAuthMandatePath({
      authenticatedAccountId: pre.accountId,
      mandateProofPresent: true,
      signatureVerified: true,
      concreteAction: true,
    });
    expect(decision).toMatchObject({ applies: true, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });

    const invalid = validateApiKey('sk_wrong');
    expect(invalid.valid).toBe(false);
    expect(invalid).not.toHaveProperty('accountId');
    expect(JSON.stringify(invalid)).not.toContain('ALLOW');
  });

  it('defines 503 and BLOCK as different classes and never ALLOW', () => {
    const kinds: Stage4FailureKind[] = [
      'no_account',
      'manifest_wrong_account',
      'manifest_unavailable',
      'replay_store_unavailable',
      'empty_mandate',
      'missing_action',
      'proof_wrong_account',
      'retired_key',
      'historical',
    ];
    for (const kind of kinds) {
      const row = stage4FailureClass(kind);
      expect(JSON.stringify(row)).not.toContain('ALLOW');
      if (row.class === 'unverifiable') {
        expect(row.httpStatus).toBe(503);
        expect(row).not.toHaveProperty('verdict');
      } else {
        expect(row.verdict).toBe('BLOCK');
        expect(row).not.toHaveProperty('httpStatus');
      }
    }

    const noAccount = decideNoAuthMandatePath({
      authenticatedAccountId: undefined,
      mandateProofPresent: true,
      signatureVerified: true,
      concreteAction: true,
    });
    expect(noAccount).toMatchObject({ httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });
    expect(stage4FailureClass('no_account')).toEqual({
      class: 'unverifiable',
      httpStatus: 503,
      code: 'ACCOUNT_UNAVAILABLE',
    });

    const empty = normalizeMandate({});
    expect(empty).toMatchObject({ ok: false, verdict: 'BLOCK', reason: 'empty' });
    expect(verdictWithMandateNormalization('ALLOW', empty, true)).toBe('BLOCK');
    expect(stage4FailureClass('empty_mandate')).toEqual({
      class: 'known_invalid',
      verdict: 'BLOCK',
      reason: 'empty',
    });
    expect(stage4FailureClass('missing_action')).toEqual({
      class: 'known_invalid',
      verdict: 'BLOCK',
      reason: 'action_missing',
    });
    expect(stage4FailureClass('proof_wrong_account')).toEqual({
      class: 'known_invalid',
      verdict: 'BLOCK',
      reason: 'account_mismatch',
    });
    expect(stage4FailureClass('manifest_wrong_account').class).toBe('unverifiable');
  });

  it('is not imported by the verify handler', () => {
    const source = readFileSync(new URL('./mandate-no-auth.ts', import.meta.url), 'utf8');
    const verify = readFileSync(new URL('../api/sentinel/verify.ts', import.meta.url), 'utf8');
    const workflow = readFileSync(
      new URL('../.github/workflows/action-authorization-suite.yml', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('toLowerCase');
    expect(source).not.toContain('api/sentinel');
    expect(source).not.toContain('mandate-replay-store');
    expect(source).not.toContain('src/engine');
    expect(verify).not.toContain('mandate-no-auth');
    expect(verify).not.toContain('decideNoAuthMandatePath');
    expect(workflow).not.toContain('mandate-no-auth');
    expect(workflow).toContain('src/engine/**');
  });
});
