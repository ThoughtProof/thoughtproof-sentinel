/**
 * Offline regressions for portable export selection (ADR-0022 review).
 * Local Ed25519 only. No network and no Sentinel calls.
 */
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DOMAIN = 'thoughtproof.sentinel.export.v1';
const SCHEMA_V1 = 'sentinel.verdict.canonical.v1';
const SCHEMA_V2 = 'sentinel.verdict.canonical.v2';
const SIGNED_AT = 1_782_916_498;
const KID = 'local-offline-ed25519';

function jcsFlat(obj: Record<string, string | number>) {
  const parts = Object.keys(obj)
    .sort()
    .filter((key) => obj[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(obj[key])}`);
  return `{${parts.join(',')}}`;
}

function digestCanonical(canonical: string) {
  return `0x${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function signFields(fields: Record<string, string | number>, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) {
  const signedInput = Buffer.concat([
    Buffer.from(DOMAIN, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(jcsFlat(fields), 'utf8'),
  ]);
  return `0x${cryptoSign(null, signedInput, privateKey).toString('hex')}`;
}

function envelope(
  artifactSchema: string,
  canonical: string,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
) {
  const fields = {
    artifactSchema,
    verificationId: 'sent_localoffline01',
    canonical,
    digest: digestCanonical(canonical),
    keyId: KID,
    alg: 'Ed25519',
    signedAt: SIGNED_AT,
  };
  return { exportSchema: DOMAIN, ...fields, signature: signFields(fields, privateKey) };
}

describe('verify-canonical-export schema selection', () => {
  let dir: string;
  let keysPath: string;
  let privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  let validV1: ReturnType<typeof envelope>;
  let validV2: ReturnType<typeof envelope>;
  let tamperedV2: ReturnType<typeof envelope>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'export-schema-'));
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string };
    keysPath = join(dir, 'keys.json');
    writeFileSync(
      keysPath,
      JSON.stringify({
        schema: 'thoughtproof.keys.v1',
        keys: [{
          kty: 'OKP',
          crv: 'Ed25519',
          x: jwk.x,
          kid: KID,
          alg: 'EdDSA',
          status: 'active',
          notBefore: '2020-01-01T00:00:00Z',
          notAfter: null,
        }],
      }),
    );
    validV1 = envelope(SCHEMA_V1, `{"artifactSchema":"${SCHEMA_V1}","verdict":"ALLOW"}`, privateKey);
    validV2 = envelope(SCHEMA_V2, `{"artifactSchema":"${SCHEMA_V2}","verdict":"ALLOW"}`, privateKey);
    tamperedV2 = { ...validV2, canonical: validV2.canonical.replace('"ALLOW"', '"BLOCK"') };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeJson(name: string, value: unknown) {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  function run(file: string, schemaArgs: string[] = []) {
    return spawnSync(
      process.execPath,
      [
        'scripts/verify-canonical-export.mjs',
        file,
        '--keys',
        keysPath,
        '--now',
        String(SIGNED_AT),
        ...schemaArgs,
      ],
      { encoding: 'utf8' },
    );
  }

  function parsed(result: ReturnType<typeof run>) {
    return JSON.parse(result.stdout) as {
      ok: boolean;
      error?: string;
      field?: string;
      artifactSchema?: string | null;
      verified_schemas: string[];
      failed_schema?: string | null;
      results?: Array<{ ok: boolean; artifactSchema?: string; error?: string }>;
    };
  }

  it('fails a response whose v1 export is valid and whose v2 export is tampered', () => {
    const file = writeJson('both.json', { signed_export: validV1, signed_export_v2: tamperedV2 });
    for (const args of [['--schema', 'all'], ['--schema', 'auto']]) {
      const result = run(file, args);
      const body = parsed(result);
      expect(result.status).not.toBe(0);
      expect(body.ok).toBe(false);
      expect(body.error).toBe('signature_invalid');
      expect(body.failed_schema).toBe(SCHEMA_V2);
      expect(body.verified_schemas).toEqual([SCHEMA_V1]);
      expect(body.results?.map((item) => item.ok)).toEqual([true, false]);
    }
  });

  it('verifies a response that contains only signed_export_v2', () => {
    const file = writeJson('v2-only-response.json', { signed_export_v2: validV2, verdict: 'ALLOW' });
    const result = run(file);
    const body = parsed(result);
    expect(result.status).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.error).toBeUndefined();
    expect(body.verified_schemas).toEqual([SCHEMA_V2]);
  });

  it('verifies a separately passed v2 envelope', () => {
    const file = writeJson('envelope-v2.json', validV2);
    const result = run(file);
    const body = parsed(result);
    expect(result.status).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.verified_schemas).toEqual([SCHEMA_V2]);
  });

  it('reports v2-only success and fails when v2 was requested but is missing', () => {
    const onlyV2 = writeJson('v2-only-success.json', { id: 'sent_localoffline01', signed_export_v2: validV2 });
    const success = run(onlyV2, ['--v2']);
    const successBody = parsed(success);
    expect(success.status).toBe(0);
    expect(successBody.ok).toBe(true);
    expect(successBody.verified_schemas).toEqual([SCHEMA_V2]);

    const missing = run(writeJson('v1-only.json', { signed_export: validV1 }), ['--schema', 'v2']);
    const missingBody = parsed(missing);
    expect(missing.status).not.toBe(0);
    expect(missingBody.ok).toBe(false);
    expect(missingBody.error).toBe('missing_fields');
    expect(missingBody.field).toBe('signed_export_v2');
    expect(missingBody.verified_schemas).toEqual([]);
  });

  it('treats an omitted signed_export_v2 key as absent and still verifies v1', () => {
    const file = writeJson('v1-key-absent.json', { signed_export: validV1, verdict: 'ALLOW' });
    for (const args of [['--schema', 'all'], ['--schema', 'auto']]) {
      const result = run(file, args);
      const body = parsed(result);
      expect(result.status).toBe(0);
      expect(body.ok).toBe(true);
      expect(body.verified_schemas).toEqual([SCHEMA_V1]);
    }
  });

  it('rejects a present non-object signed_export_v2 instead of ignoring it', () => {
    const badValues: unknown[] = [null, 'not-an-export', [], false, 0];
    for (const bad of badValues) {
      const label = Array.isArray(bad) ? 'array' : String(bad);
      const file = writeJson(`bad-v2-${label}.json`, {
        signed_export: validV1,
        signed_export_v2: bad,
      });
      for (const args of [['--schema', 'all'], ['--schema', 'auto'], ['--schema', 'v2']]) {
        const result = run(file, args);
        const body = parsed(result);
        expect(result.status).toBe(2);
        expect(body.ok).toBe(false);
        expect(body.error).toBe('invalid_export');
        expect(body.field).toBe('signed_export_v2');
        expect(body.verified_schemas).toEqual([]);
      }
    }
  });

  it('rejects a present non-object signed_export under auto', () => {
    const file = writeJson('null-v1.json', { signed_export: null, signed_export_v2: validV2 });
    const result = run(file, ['--schema', 'auto']);
    const body = parsed(result);
    expect(result.status).toBe(2);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('invalid_export');
    expect(body.field).toBe('signed_export');
    expect(body.verified_schemas).toEqual([]);
  });

  it('rejects a v1 envelope stored in the signed_export_v2 field', () => {
    const file = writeJson('v1-in-v2-slot.json', {
      signed_export: validV1,
      signed_export_v2: validV1,
    });
    for (const args of [['--schema', 'all'], ['--schema', 'auto'], ['--schema', 'v2']]) {
      const result = run(file, args);
      const body = parsed(result);
      expect(result.status).toBe(2);
      expect(body.ok).toBe(false);
      expect(body.error).toBe('schema_field_mismatch');
      expect(body.field).toBe('signed_export_v2');
      expect(body.artifactSchema).toBe(SCHEMA_V1);
      expect(body.verified_schemas).toEqual([]);
    }
  });

  it('rejects a v2 envelope stored in the signed_export field', () => {
    const file = writeJson('v2-in-v1-slot.json', {
      signed_export: validV2,
      signed_export_v2: validV2,
    });
    const result = run(file, ['--schema', 'auto']);
    const body = parsed(result);
    expect(result.status).toBe(2);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('schema_field_mismatch');
    expect(body.field).toBe('signed_export');
    expect(body.artifactSchema).toBe(SCHEMA_V2);
    expect(body.verified_schemas).toEqual([]);
  });

  it('rejects a top-level envelope that also carries a nested export', () => {
    const file = writeJson('mixed-envelope.json', {
      ...validV1,
      signed_export_v2: tamperedV2,
    });
    for (const args of [['--schema', 'all'], ['--schema', 'auto'], ['--schema', 'v2']]) {
      const result = run(file, args);
      const body = parsed(result);
      expect(result.status).toBe(2);
      expect(body.ok).toBe(false);
      expect(body.error).toBe('ambiguous_input');
      expect(body.verified_schemas).toEqual([]);
    }
  });

  it('does not fail --schema v2 because a sibling signed_export is null', () => {
    const file = writeJson('v2-ignores-null-v1.json', {
      signed_export: null,
      signed_export_v2: validV2,
    });
    const result = run(file, ['--schema', 'v2']);
    const body = parsed(result);
    expect(result.status).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.verified_schemas).toEqual([SCHEMA_V2]);
  });

  it('verifies v2 when gate.checked and gate.skipped are a typed partition', () => {
    const canonical = JSON.stringify({
      artifactSchema: SCHEMA_V2,
      verdict: 'ALLOW',
      gate: {
        mode: 'shadow',
        wouldBlock: false,
        enforced: false,
        violations: [],
        checked: ['recipient_mismatch', 'amount_overshoot'],
        skipped: [{ kind: 'unlimited_approval', reason: 'missing_allowance' }],
      },
    });
    const file = writeJson('v2-gate-report.json', envelope(SCHEMA_V2, canonical, privateKey));
    const result = run(file, ['--schema', 'v2']);
    const body = parsed(result);
    expect(result.status).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.verified_schemas).toEqual([SCHEMA_V2]);
  });

  it('still verifies a v2 gate that has no checked or skipped keys', () => {
    const canonical = JSON.stringify({
      artifactSchema: SCHEMA_V2,
      verdict: 'BLOCK',
      gate: { mode: 'enforce', wouldBlock: true, enforced: true, violations: ['overshoot'] },
    });
    const file = writeJson('v2-gate-legacy.json', envelope(SCHEMA_V2, canonical, privateKey));
    const result = run(file, ['--schema', 'v2']);
    expect(result.status).toBe(0);
    expect(parsed(result).ok).toBe(true);
  });

  it('does not apply the gate report check to v1', () => {
    const canonical = JSON.stringify({
      artifactSchema: SCHEMA_V1,
      verdict: 'ALLOW',
      gate: { checked: 'not-an-array', skipped: null },
    });
    const file = writeJson('v1-ignores-gate-report.json', envelope(SCHEMA_V1, canonical, privateKey));
    const result = run(file, ['--schema', 'v1']);
    expect(result.status).toBe(0);
    expect(parsed(result).verified_schemas).toEqual([SCHEMA_V1]);
  });

  it('fails closed when v2 gate.checked or gate.skipped has an invalid type', () => {
    const badGates: unknown[] = [
      { checked: 'amount_overshoot', skipped: [] },
      { checked: null, skipped: [] },
      { checked: ['nope'], skipped: [] },
      { checked: ['amount_overshoot', 'amount_overshoot'], skipped: [] },
      { checked: ['amount_overshoot'], skipped: 'missing' },
      { checked: ['amount_overshoot'], skipped: [{ kind: 'recipient_mismatch' }] },
      {
        checked: ['amount_overshoot'],
        skipped: [{ kind: 'recipient_mismatch', reason: 'because the caller said so' }],
      },
      {
        checked: ['amount_overshoot'],
        skipped: [{ kind: 'recipient_mismatch', reason: 'missing_action_recipient', detail: 'secret' }],
      },
      { checked: ['amount_overshoot'], skipped: [{ kind: 'amount_overshoot', reason: 'missing_granted_amount' }] },
      [],
      null,
      'shadow',
    ];
    for (const [index, gate] of badGates.entries()) {
      const canonical = JSON.stringify({ artifactSchema: SCHEMA_V2, verdict: 'ALLOW', gate });
      const file = writeJson(`v2-bad-gate-${index}.json`, envelope(SCHEMA_V2, canonical, privateKey));
      const result = run(file, ['--schema', 'v2']);
      const body = parsed(result) as { ok: boolean; error?: string; code?: string; detail?: string };
      expect(result.status).not.toBe(0);
      expect(body.ok).toBe(false);
      expect(body.error).toBe('gate_report_invalid');
      expect(body.code).toBe('GATE_REPORT_INVALID');
      expect(body.detail ?? '').not.toContain('secret');
      expect(JSON.stringify(body)).not.toContain('because the caller said so');
    }
  });
});
