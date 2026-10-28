/**
 * Offline mandate normalization. No network and no provider keys.
 * Key pairs used to show a correct signature are generated here and
 * are not written to the repo.
 */
import { generateKeyPairSync, sign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTION_KINDS,
  boundedPermissionCompatibleWithMandate,
  informationalActionMayPublicAllow,
} from './engine/action-auth-kind.js';
import {
  parseMandateProofSignature,
  stage4TransportAccepts,
} from './mandate-proof-signature.js';
import {
  MANDATE_MAX_KEYS,
  MANDATE_MAX_STRING_UTF8_BYTES,
  MANDATE_MAX_UTF8_BYTES,
  MANDATE_NORMALIZATION_VERSION,
  normalizeMandate,
  verdictWithMandateNormalization,
  type MandateGateVerdict,
  type MandateNormalizeResult,
} from './mandate-normalize.js';
import {
  PRINCIPAL_MANDATE_DOMAIN,
  PRINCIPAL_MANDATE_PURPOSE,
  PRINCIPAL_MANDATE_SCHEMA,
  principalMandateSignedBytes,
  verifyPrincipalMandate,
  type PrincipalProofFields,
} from './principal-key-manifest.js';

const NOW = 1_800_000_000;
const ACCOUNT = 'acct-normalize';
const KID = 'kid-normalize';

const primary = generateKeyPairSync('ed25519');

function okpX(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

const PRIMARY_X = okpX(primary.publicKey);

function fields(): PrincipalProofFields {
  return {
    schema_version: PRINCIPAL_MANDATE_SCHEMA,
    nonce: 'nonce-normalize-1',
    iat: NOW,
    exp: NOW + 60,
    account_id: ACCOUNT,
    environment: 'production',
    purpose: PRINCIPAL_MANDATE_PURPOSE,
    principal_kid: KID,
  };
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const TRANSFER = {
  kind: 'value_transfer',
  granted: { maxAmount: 1, asset: 'USDC', recipient: 'r' },
  action: { kind: 'value_transfer', amount: 1, asset: 'USDC', recipient: 'r' },
};

function expectBlock(result: MandateNormalizeResult, reason: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.verdict).toBe('BLOCK');
    expect(result.reason).toBe(reason);
  }
  expect(result).not.toHaveProperty('mandate');
  expect(JSON.stringify(result)).not.toContain('ALLOW');
}

describe('mandate normalization', () => {
  it('pins the concrete kinds as every action kind except unknown', () => {
    expect(MANDATE_NORMALIZATION_VERSION).toBe('sentinel.mandate.normalized.v1');
    expect(ACTION_KINDS).toEqual([
      'informational',
      'value_transfer',
      'permission',
      'deploy_ship',
      'unknown',
    ]);
  });

  it('rejects an empty object and a mandate with no action', () => {
    expectBlock(normalizeMandate({}), 'empty');
    expectBlock(normalizeMandate('{}'), 'empty');
    const missingText = JSON.stringify({
      kind: 'value_transfer',
      granted: { maxAmount: 1, asset: 'USDC', recipient: 'r' },
    });
    const missing = normalizeMandate(missingText);
    expectBlock(missing, 'action_missing');
    if (!missing.ok) expect(missing.offset).toBe(0);
  });

  it('rejects an action that is not concrete', () => {
    expectBlock(normalizeMandate({ action: {} }), 'action_not_concrete');
    expectBlock(normalizeMandate({ action: { kind: 'unknown' } }), 'action_not_concrete');
    expectBlock(
      normalizeMandate({ action: { kind: 'value_transfer', amount: 1, asset: 'USDC' } }),
      'action_not_concrete',
    );
    expectBlock(normalizeMandate({ action: { kind: 'permission' } }), 'action_not_concrete');
    expectBlock(normalizeMandate({ action: [] }), 'action_not_concrete');
    expectBlock(normalizeMandate({ action: null }), 'action_not_concrete');
  });

  it('normalizes a concrete action and does not return ALLOW', () => {
    const info = normalizeMandate({
      action: { kind: 'informational', content: 'status ping', recipient: 'ops' },
    });
    const infoJson = '{"action":{"content":"status ping","kind":"informational","recipient":"ops"}}';
    expect(info).toEqual({
      ok: true,
      mandate: {
        action: { kind: 'informational', content: 'status ping', recipient: 'ops' },
      },
      canonicalJson: infoJson,
      canonicalBytes: Buffer.byteLength(infoJson, 'utf8'),
    });
    expect(info).not.toHaveProperty('verdict');
    expect(JSON.stringify(info)).not.toContain('ALLOW');

    const ship = normalizeMandate({
      kind: 'deploy_ship',
      action: { kind: 'deploy_ship', target: 'pkg', revision: '1.2.3' },
    });
    expect(ship).toMatchObject({
      ok: true,
      mandate: {
        kind: 'deploy_ship',
        action: { kind: 'deploy_ship', target: 'pkg', revision: '1.2.3' },
      },
    });

    const permission = normalizeMandate({
      action: { kind: 'permission', allowance: 1, asset: ' USDC ', recipient: ' spender ' },
    });
    expect(permission).toMatchObject({
      ok: true,
      mandate: {
        action: { kind: 'permission', allowance: '1', asset: 'USDC', recipient: 'spender' },
      },
    });
    if (permission.ok) {
      expect(permission.canonicalJson).toContain('"allowance":"1"');
      expect(permission.canonicalJson).not.toContain('MAX_UINT256');
    }
  });

  it('folds aliases into one canonical object and rejects a conflict', () => {
    const aliased = normalizeMandate({
      kind: 'value_transfer',
      granted: { maxAmountUsd: 1, asset: 'USDC', recipient: 'r' },
      action: { kind: 'value_transfer', amount_usd: 1, asset: 'USDC', recipient: 'r' },
    });
    const canonical = normalizeMandate(TRANSFER);
    expect(aliased.ok).toBe(true);
    expect(canonical.ok).toBe(true);
    if (aliased.ok && canonical.ok) {
      expect(aliased.canonicalJson).toBe(canonical.canonicalJson);
      expect(aliased.mandate).toEqual(canonical.mandate);
      expect(aliased.canonicalJson).not.toContain('amount_usd');
      expect(aliased.canonicalJson).not.toContain('maxAmountUsd');
    }
    const again = aliased.ok ? normalizeMandate(aliased.mandate) : aliased;
    if (aliased.ok && again.ok) expect(again.canonicalJson).toBe(aliased.canonicalJson);

    expectBlock(
      normalizeMandate({
        action: {
          kind: 'value_transfer',
          amount: 1,
          amountUsd: 2,
          asset: 'USDC',
          recipient: 'r',
        },
      }),
      'alias_conflict',
    );
  });

  it('rejects unknown fields instead of dropping them', () => {
    expectBlock(
      normalizeMandate({ action: { kind: 'informational', note: 'extra' } }),
      'unknown_field',
    );
    expectBlock(
      normalizeMandate({
        action: { kind: 'value_transfer', amount: 1, asset: 'USDC', recipient: 'r', allowance: 1 },
      }),
      'unknown_field',
    );
    expectBlock(
      normalizeMandate({ action: { kind: 'informational' }, schema_version: 'v1' }),
      'unknown_field',
    );
    expectBlock(normalizeMandate({ action: { kind: 'informational', amountUsd: 1 } }), 'unknown_field');
  });

  it('rejects prototype keys and does not copy them onto the result', () => {
    const parsed = JSON.parse('{"__proto__":{"admin":true},"action":{"kind":"informational"}}');
    expectBlock(normalizeMandate(parsed), 'prototype_key');
    expect((Object.prototype as { admin?: boolean }).admin).toBeUndefined();

    const text = '{"constructor":{"prototype":{"admin":true}},"action":{"kind":"informational"}}';
    const fromText = normalizeMandate(text);
    expectBlock(fromText, 'prototype_key');
    if (!fromText.ok) expect(fromText.offset).toBe(text.indexOf('"constructor"'));

    const dirty = Object.create({ admin: true }) as Record<string, unknown>;
    dirty.action = { kind: 'informational' };
    expectBlock(normalizeMandate(dirty), 'prototype_key');
    const normalized = normalizeMandate({ action: { kind: 'informational' } });
    expect(normalized).not.toHaveProperty('admin');
  });

  it('rejects malformed types, kind mismatch, and non-objects', () => {
    expectBlock(normalizeMandate(null), 'not_object');
    expectBlock(normalizeMandate([]), 'not_object');
    expectBlock(normalizeMandate('[]'), 'not_object');
    expectBlock(normalizeMandate(1), 'not_object');
    expectBlock(
      normalizeMandate({
        kind: 'unknown',
        action: { kind: 'informational', content: 'status', recipient: 'ops' },
      }),
      'malformed',
    );
    expectBlock(normalizeMandate({ action: { kind: 'pay' } }), 'action_not_concrete');
    expectBlock(
      normalizeMandate({
        action: { kind: 'value_transfer', amount: -1, asset: 'USDC', recipient: 'r' },
      }),
      'malformed',
    );
    expectBlock(
      normalizeMandate({
        action: { kind: 'value_transfer', amount: Number.NaN, asset: 'USDC', recipient: 'r' },
      }),
      'malformed',
    );
    expectBlock(
      normalizeMandate({
        action: { kind: 'informational', content: 'status', recipient: 'ops' },
        granted: {},
      }),
      'malformed',
    );
    expectBlock(
      normalizeMandate({
        action: { kind: 'permission', allowance: '', asset: 'USDC', recipient: 'spender' },
      }),
      'malformed',
    );
    const cycle: Record<string, unknown> = {};
    cycle.action = cycle;
    expectBlock(normalizeMandate(cycle), 'action_not_concrete');
  });

  it('enforces size and depth limits', () => {
    expectBlock(normalizeMandate('a'.repeat(MANDATE_MAX_UTF8_BYTES + 1)), 'too_large');
    const huge = normalizeMandate('a'.repeat(MANDATE_MAX_UTF8_BYTES + 1));
    if (!huge.ok) expect(huge.offset).toBe(0);

    const recipient = 'r'.repeat(MANDATE_MAX_STRING_UTF8_BYTES + 1);
    expectBlock(
      normalizeMandate({
        action: { kind: 'value_transfer', amount: 1, asset: 'USDC', recipient },
      }),
      'malformed',
    );

    const many: Record<string, unknown> = { action: { kind: 'informational' } };
    for (let n = 0; n < MANDATE_MAX_KEYS; n++) many[`k${n}`] = 1;
    expectBlock(normalizeMandate(many), 'too_large');

    let deep = '1';
    for (let n = 0; n < 20; n++) deep = `{"a":${deep}}`;
    const nested = normalizeMandate(deep);
    expectBlock(nested, 'malformed');
    if (!nested.ok) {
      expect(nested.offset).toBeGreaterThanOrEqual(0);
      expect(nested.offset).toBeLessThanOrEqual(deep.length);
    }

    const spaces = ' '.repeat(8000);
    const spaced = normalizeMandate(spaces);
    expectBlock(spaced, 'malformed');
    if (!spaced.ok) expect(spaced.offset).toBe(spaces.length);
  });

  it('computes offsets on the original text, not a lowercased copy', () => {
    const dotted = '\u0130';
    expect(dotted.toLowerCase().length).toBeGreaterThan(dotted.length);
    const recipient = `r${dotted}`;
    const text = JSON.stringify({
      kind: 'value_transfer',
      granted: { maxAmount: 1, asset: 'USDC', recipient },
      action: { kind: 'value_transfer', amount: 1, asset: 'USDC', recipient },
    });
    const ok = normalizeMandate(text);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.spans?.action.start).toBe(text.indexOf('"action"'));
      expect(text.toLowerCase().indexOf('"action"')).not.toBe(text.indexOf('"action"'));
      expect(text.slice(ok.spans?.action.start, ok.spans?.action.end)).toBe('"action"');
    }

    const withExtra = `${text.slice(0, -1)},"extra":1}`;
    const extra = normalizeMandate(withExtra);
    expectBlock(extra, 'unknown_field');
    if (!extra.ok) {
      expect(extra.offset).toBe(withExtra.indexOf('"extra"'));
      expect(withExtra.toLowerCase().indexOf('"extra"')).not.toBe(extra.offset);
    }
  });

  it('does not treat the word action inside a string as the action key', () => {
    const text =
      '{"kind":"informational","granted":{"recipient":"action"},"action":{"kind":"informational","content":"status","recipient":"ops"}}';
    const result = normalizeMandate(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spans?.action.start).toBe(text.lastIndexOf('"action"'));
      expect(result.spans?.action.start).not.toBe(text.indexOf('"action"'));
      expect(text.slice(result.spans?.action.start, result.spans?.action.end)).toBe('"action"');
    }
  });

  it('rejects duplicate keys in the original text', () => {
    const text = '{"action":{"kind":"informational"},"action":{"kind":"deploy_ship"}}';
    const result = normalizeMandate(text);
    expectBlock(result, 'malformed');
    if (!result.ok) expect(result.offset).toBe(text.lastIndexOf('"action"'));
  });

  it('does not let a correct signature turn {} or a missing action into ALLOW', async () => {
    const empty = {};
    const proof = fields();
    const bytes = principalMandateSignedBytes(empty, proof);
    expect(bytes).not.toBeNull();
    const signature = sign(null, bytes as Buffer, primary.privateKey).toString('hex');
    expect(cryptoVerify(null, bytes as Buffer, primary.publicKey, Buffer.from(signature, 'hex'))).toBe(
      true,
    );

    const stage3 = await verifyPrincipalMandate({
      authenticatedAccountId: ACCOUNT,
      mandate: empty,
      mandateProof: { ...proof, signature },
      nowSeconds: NOW,
      targetEnvironment: 'production',
      store: {
        load() {
          return {
            answered: true as const,
            manifest: {
              accountId: ACCOUNT,
              keys: [
                {
                  kty: 'OKP' as const,
                  crv: 'Ed25519' as const,
                  alg: 'EdDSA' as const,
                  x: PRIMARY_X,
                  kid: KID,
                  status: 'active' as const,
                  notBefore: iso(NOW - 1000),
                  notAfter: iso(NOW + 1000),
                },
              ],
            },
          };
        },
      },
    });
    expect(stage3).toMatchObject({ ok: true, mandateSource: 'principal_signed' });
    expect(stage3).not.toHaveProperty('verdict');

    const normalized = normalizeMandate(empty);
    expectBlock(normalized, 'empty');
    expect(verdictWithMandateNormalization('ALLOW', normalized, true)).toBe('BLOCK');
    expect(verdictWithMandateNormalization('ALLOW', normalizeMandate({ granted: { maxAmount: 1 } }), true)).toBe(
      'BLOCK',
    );
  });

  it('rejects an incomplete action for every supported kind', () => {
    const cases: Array<{ full: Record<string, unknown>; fields: string[] }> = [
      {
        full: { kind: 'value_transfer', amount: 1, asset: 'USDC', recipient: 'r' },
        fields: ['amount', 'asset', 'recipient'],
      },
      {
        full: { kind: 'permission', allowance: '1', asset: 'USDC', recipient: 'spender' },
        fields: ['allowance', 'asset', 'recipient'],
      },
      {
        full: { kind: 'informational', content: 'status ping', recipient: 'ops' },
        fields: ['content', 'recipient'],
      },
      {
        full: { kind: 'deploy_ship', target: 'pkg', revision: '1.2.3' },
        fields: ['target', 'revision'],
      },
    ];
    const signature = 'ab'.repeat(64);
    expect(parseMandateProofSignature(signature).ok).toBe(true);
    for (const entry of cases) {
      for (const field of entry.fields) {
        const action = { ...entry.full };
        delete action[field];
        const result = normalizeMandate({ action });
        expectBlock(result, 'action_not_concrete');
        expect(verdictWithMandateNormalization('ALLOW', result, true)).toBe('BLOCK');
        expect(verdictWithMandateNormalization('UNCERTAIN', result, true)).toBe('BLOCK');
        expect(stage4TransportAccepts(result, parseMandateProofSignature(signature))).toBe(false);
        expect(JSON.stringify(result)).not.toContain('ALLOW');
      }
      const bound = normalizeMandate({ action: entry.full });
      expect(bound.ok).toBe(true);
      expect(stage4TransportAccepts(bound, parseMandateProofSignature(signature))).toBe(true);
      expect(verdictWithMandateNormalization('BLOCK', bound, true)).toBe('BLOCK');
      expect(bound).not.toHaveProperty('verdict');
    }
    expectBlock(normalizeMandate({ action: { kind: 'deploy_ship' } }), 'action_not_concrete');
    expectBlock(normalizeMandate({ action: { kind: 'informational' } }), 'action_not_concrete');
    expectBlock(
      normalizeMandate({ action: { kind: 'permission', allowance: 1 } }),
      'action_not_concrete',
    );
  });

  it('rejects blank identities and unparseable allowances', () => {
    const transfer = { kind: 'value_transfer', amount: 1, asset: 'USDC', recipient: 'r' };
    for (const field of ['asset', 'recipient'] as const) {
      expectBlock(normalizeMandate({ action: { ...transfer, [field]: ' ' } }), 'malformed');
      expectBlock(normalizeMandate({ action: { ...transfer, [field]: '\n\t' } }), 'malformed');
    }
    expectBlock(
      normalizeMandate({
        action: { kind: 'informational', content: '  ', recipient: 'ops' },
      }),
      'malformed',
    );
    expectBlock(
      normalizeMandate({
        action: { kind: 'deploy_ship', target: 'pkg', revision: ' ' },
      }),
      'malformed',
    );
    expectBlock(
      normalizeMandate({
        granted: { maxAmount: 1, asset: ' ', recipient: 'r' },
        action: transfer,
      }),
      'malformed',
    );

    const permission = { kind: 'permission', allowance: '1', asset: 'USDC', recipient: 'spender' };
    for (const allowance of [
      '-1',
      'not-an-allowance',
      '01',
      '1e2',
      ' 1',
      '1 ',
      '+1',
      '1.0',
      'MAX_UINT256',
      'Unlimited',
      '0x10',
      '',
    ]) {
      const result = normalizeMandate({ action: { ...permission, allowance } });
      expectBlock(result, 'malformed');
      expect(verdictWithMandateNormalization('ALLOW', result, true)).toBe('BLOCK');
    }
    const numbered = normalizeMandate({ action: { ...permission, allowance: 1 } });
    expect(numbered).toMatchObject({
      ok: true,
      mandate: { action: { allowance: '1', asset: 'USDC', recipient: 'spender' } },
    });
    const unlimited = normalizeMandate({ action: { ...permission, allowance: 'unlimited' } });
    expect(unlimited).toMatchObject({
      ok: true,
      mandate: { action: { allowance: 'unlimited' } },
    });
    const trimmed = normalizeMandate({
      action: { ...transfer, asset: ' USDC ', recipient: ' r ' },
    });
    expect(trimmed).toMatchObject({
      ok: true,
      mandate: { action: { asset: 'USDC', recipient: 'r' } },
    });
  });

  it('preserves a value_transfer mandate with a bounded permission action', () => {
    const mandate = {
      kind: 'value_transfer' as const,
      granted: { maxAmount: 100, asset: 'USDC', recipient: '0xUNIROUTER' },
      action: {
        kind: 'permission' as const,
        amount: 100,
        allowance: '100',
        asset: 'USDC',
        recipient: '0xUNIROUTER',
      },
    };
    expect(boundedPermissionCompatibleWithMandate('', '', mandate)).toBe(true);
    expect(
      informationalActionMayPublicAllow('permission', 'value_transfer', {
        boundedPermissionCompatible: true,
        mandate,
      }),
    ).toBe(true);

    const normalized = normalizeMandate(mandate);
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.mandate.kind).toBe('value_transfer');
      expect(normalized.mandate.action.kind).toBe('permission');
      expect(normalized.mandate.action.allowance).toBe('100');
    }
    expect(normalized).not.toHaveProperty('verdict');
    expect(verdictWithMandateNormalization('BLOCK', normalized, true)).toBe('BLOCK');
    expect(verdictWithMandateNormalization('UNCERTAIN', normalized, true)).toBe('UNCERTAIN');
    expect(JSON.stringify(normalized)).not.toContain('ALLOW');

    const unbounded = {
      ...mandate,
      action: { ...mandate.action, allowance: 'unlimited' },
    };
    expect(boundedPermissionCompatibleWithMandate('', '', unbounded)).toBe(false);
    expect(
      informationalActionMayPublicAllow('permission', 'value_transfer', {
        boundedPermissionCompatible: false,
        mandate: unbounded,
      }),
    ).toBe(false);
    const described = normalizeMandate(unbounded);
    expect(described.ok).toBe(true);
    if (described.ok) {
      expect(described.mandate.kind).toBe('value_transfer');
      expect(described.mandate.action.kind).toBe('permission');
    }
    expect(verdictWithMandateNormalization('BLOCK', described, true)).toBe('BLOCK');
  });

  it('does not let signature validity change a gate verdict', () => {
    const ok = normalizeMandate(TRANSFER);
    const bad = normalizeMandate({});
    const gates: MandateGateVerdict[] = ['ALLOW', 'BLOCK', 'UNCERTAIN'];
    for (const gate of gates) {
      expect(verdictWithMandateNormalization(gate, ok, true)).toBe(
        verdictWithMandateNormalization(gate, ok, false),
      );
      expect(verdictWithMandateNormalization(gate, bad, true)).toBe(
        verdictWithMandateNormalization(gate, bad, false),
      );
    }
    expect(verdictWithMandateNormalization('ALLOW', ok, true)).toBe('ALLOW');
    expect(verdictWithMandateNormalization('BLOCK', ok, true)).toBe('BLOCK');
    expect(verdictWithMandateNormalization('UNCERTAIN', ok, true)).toBe('UNCERTAIN');
    expect(verdictWithMandateNormalization('ALLOW', bad, true)).toBe('BLOCK');
    expect(verdictWithMandateNormalization('UNCERTAIN', bad, true)).toBe('BLOCK');
    expect(verdictWithMandateNormalization('BLOCK', bad, true)).toBe('BLOCK');
  });

  it('stays off the request path and does not lowercase mandate text', () => {
    const source = readFileSync(new URL('./mandate-normalize.ts', import.meta.url), 'utf8');
    const verify = readFileSync(new URL('../api/sentinel/verify.ts', import.meta.url), 'utf8');
    const validation = readFileSync(new URL('./validation.ts', import.meta.url), 'utf8');
    const manifest = readFileSync(new URL('./principal-key-manifest.ts', import.meta.url), 'utf8');
    const replay = readFileSync(new URL('./mandate-replay-store.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('toLowerCase');
    expect(source).not.toContain('toLocaleLowerCase');
    expect(source).not.toContain('engine/');
    expect(source).not.toContain('api/sentinel');
    expect(source).not.toContain('mandate-replay-store');
    expect(source).not.toContain('process.env');
    expect(verify).not.toContain('mandate-normalize');
    expect(verify).not.toContain('normalizeMandate');
    expect(validation).not.toContain('mandate-normalize');
    expect(manifest).not.toContain('mandate-normalize');
    expect(replay).not.toContain('mandate-normalize');
    expect(PRINCIPAL_MANDATE_DOMAIN).toBe('thoughtproof.sentinel.mandate.v1');
  });
});
