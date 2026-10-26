/**
 * Salted mandate/action commitments on canonical.v2 (ADR-0022 addendum).
 * Offline. Local Ed25519 only. No network and no Sentinel calls.
 *
 * An unsalted sha256 of a mandate is dictionary-reversible: amount, recipient,
 * and kind are a small domain. The tests below show that dictionary hit, and
 * that a 32-byte salt (kept off the public receipt) blocks it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore canonicalize types are loose; runtime export is the function
import canonicalize from 'canonicalize';
import {
  clearExportSignerReadinessCache,
  generateExportKeyPair,
  issueSignedCanonicalExport,
  maybeIssueSignedExport,
  maybeIssueSignedExportV2,
} from './canonical-export.js';
import {
  buildCanonicalSentinelVerdict,
  buildCanonicalSentinelVerdictV2,
  serializeCanonicalSentinelVerdict,
} from './canonical-verdict.js';
import {
  COMMITMENT_SALT_BYTES,
  computeMandateActionCommitments,
  digestSaltIfCommitted,
  prepareV2CommitmentSupplements,
  responseDigestSalt,
  saltedCommitmentDigest,
} from './package-digest.js';
import type { SentinelVerifyResponse } from './types.js';

// @ts-expect-error The portable verifier is plain JavaScript.
import { portableSaltedCommitmentDigest } from '../scripts/verify-canonical-export.mjs';
// @ts-expect-error The receipt allowlist helper is plain JavaScript.
import { redactSuiteReceipt, SUITE_RECEIPT_ALLOWLIST } from '../scripts/lib/action-auth-suite-receipt.mjs';

const SALT = Buffer.from('11'.repeat(32), 'hex');
const OTHER_SALT = Buffer.from('22'.repeat(32), 'hex');
const SIGNED_AT = 1_782_916_498;

const mandate = {
  kind: 'value_transfer',
  granted: { maxAmount: 200, recipient: '0xabc', asset: 'USDC' },
  action: { kind: 'value_transfer', amount: 200, recipient: '0xabc', asset: 'USDC' },
};

function unsalted(value: unknown): string {
  const jcs = (canonicalize as unknown as (v: unknown) => string)(value);
  return createHash('sha256').update(jcs, 'utf8').digest('hex');
}

function response(): SentinelVerifyResponse {
  return {
    id: 'sent_9f3c2a7b1e004d68',
    verdict: 'BLOCK',
    confidence: 0.84,
    reasoning: 'Amount exceeds the mandate.',
    objections: [],
    mode: 'action_authorization',
    tier: 'standard',
    meta: {
      duration_ms: 10,
      models_used: ['serv-nano'],
      verified_at: '2026-07-01T14:34:58.000Z',
      promotion: {
        cascade_reason: null,
        internal_verdict: 'BLOCK',
        mapped_verdict: 'BLOCK',
        public_verdict: 'BLOCK',
        promoted: false,
        reason: 'already_block',
        steps_all_pass: false,
        machine_condition_proof_present: false,
        machine_condition_proof_accepted: false,
        release_id: 'da6b6378e105d0c7e1f810bbe237d2f23c55c103',
        policy: 'adr-0019-cascade-promotion-2026-08-08+p0-primary-error-fail-closed',
      },
    },
  };
}

describe('salted mandate and action commitments', () => {
  it('is deterministic for a fixed salt, including key order', () => {
    const first = computeMandateActionCommitments(mandate, SALT);
    const reordered = computeMandateActionCommitments(
      {
        action: { asset: 'USDC', recipient: '0xabc', amount: 200, kind: 'value_transfer' },
        granted: { asset: 'USDC', recipient: '0xabc', maxAmount: 200 },
        kind: 'value_transfer',
      },
      SALT,
    );
    expect(first).toEqual(reordered);
    expect(first?.digestSalt).toBe('11'.repeat(32));
    expect(first?.mandateDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first?.actionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first?.mandateDigest).not.toBe(first?.actionDigest);
    expect(saltedCommitmentDigest(mandate, SALT)).toBe(first?.mandateDigest);
    expect(saltedCommitmentDigest(mandate.action, SALT)).toBe(first?.actionDigest);
  });

  it('changes the digest when the salt changes', () => {
    const a = computeMandateActionCommitments(mandate, SALT);
    const b = computeMandateActionCommitments(mandate, OTHER_SALT);
    expect(a?.mandateDigest).not.toBe(b?.mandateDigest);
    expect(a?.actionDigest).not.toBe(b?.actionDigest);
    expect(a?.digestSalt).not.toBe(b?.digestSalt);
  });

  it('generates a fresh 32-byte salt when the caller does not pass one', () => {
    const a = computeMandateActionCommitments(mandate);
    const b = computeMandateActionCommitments(mandate);
    expect(a?.digestSalt).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(a!.digestSalt, 'hex')).toHaveLength(COMMITMENT_SALT_BYTES);
    expect(a?.digestSalt).not.toBe(b?.digestSalt);
    expect(a?.mandateDigest).not.toBe(b?.mandateDigest);
  });

  it('omits a digest when the mandate or the action is absent', () => {
    expect(computeMandateActionCommitments(undefined)).toBeUndefined();
    expect(computeMandateActionCommitments(null)).toBeUndefined();
    expect(prepareV2CommitmentSupplements(undefined)).toEqual({});

    const grantedOnly = computeMandateActionCommitments(
      { granted: { maxAmount: 200, recipient: '0xabc' } },
      SALT,
    );
    expect(grantedOnly?.mandateDigest).toMatch(/^sha256:/);
    expect(grantedOnly?.actionDigest).toBeUndefined();

    const body = buildCanonicalSentinelVerdictV2(response(), {
      potCli: '0.8.12',
      mandateDigest: grantedOnly?.mandateDigest,
    });
    expect(body.actionDigest).toBeUndefined();
    const parsed = JSON.parse(serializeCanonicalSentinelVerdict(body)) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('actionDigest');
    expect(parsed).not.toHaveProperty('digestSalt');
    expect(parsed.mandateDigest).toBe(grantedOnly?.mandateDigest);
  });

  it('omits the field when hashing fails and does not drop the other digest', () => {
    const action = { amount: 10, recipient: '0xabc' };
    const cyclic: Record<string, unknown> = { action };
    cyclic.self = cyclic;
    const partial = computeMandateActionCommitments(cyclic, SALT);
    expect(partial?.mandateDigest).toBeUndefined();
    expect(partial?.actionDigest).toBe(saltedCommitmentDigest(action, SALT));

    const both: Record<string, unknown> = {};
    both.self = both;
    expect(computeMandateActionCommitments(both, SALT)).toBeUndefined();
    expect(computeMandateActionCommitments(mandate, Buffer.alloc(16))).toBeUndefined();
  });

  it('notes that an unsalted digest is dictionary-reversible and the salt blocks that dictionary', () => {
    // Low-entropy domain: three amounts and two recipients. No salt required
    // to recover the mandate. The salted commitment does not match that
    // dictionary unless the attacker already has the 32-byte salt.
    const target = { granted: { maxAmount: 200, recipient: '0xabc' } };
    const domain = [100, 200, 2000].flatMap((maxAmount) =>
      ['0xabc', '0xdef'].map((recipient) => ({ granted: { maxAmount, recipient } })),
    );
    const bare = unsalted(target);
    const found = domain.find((candidate) => unsalted(candidate) === bare);
    expect(found).toEqual(target);

    const salted = saltedCommitmentDigest(target, SALT);
    expect(salted).not.toBe(`sha256:${bare}`);
    const blinded = domain.find(
      (candidate) => saltedCommitmentDigest(candidate, Buffer.alloc(32, 0)) === salted,
    );
    expect(blinded).toBeUndefined();
    const withSalt = domain.find((candidate) => saltedCommitmentDigest(candidate, SALT) === salted);
    expect(withSalt).toEqual(target);
  });

  it('matches the portable verifier JCS byte for byte', () => {
    const messy = {
      b: 1,
      a: { z: 'ü', y: [1, 2, { inner: true }] },
      n: 2000.5,
    };
    expect(portableSaltedCommitmentDigest(messy, SALT)).toBe(saltedCommitmentDigest(messy, SALT));
    expect(portableSaltedCommitmentDigest(mandate.action, OTHER_SALT)).toBe(
      saltedCommitmentDigest(mandate.action, OTHER_SALT),
    );
  });

  it('keeps the verdict, the promotion, and v1 bytes unchanged', () => {
    const current = response();
    const before = structuredClone(current);
    const commitments = computeMandateActionCommitments(mandate, SALT);
    const v1 = serializeCanonicalSentinelVerdict(buildCanonicalSentinelVerdict(current));
    const v2 = buildCanonicalSentinelVerdictV2(current, {
      potCli: '0.8.12',
      mandateDigest: commitments?.mandateDigest,
      actionDigest: commitments?.actionDigest,
    });
    const v1Again = serializeCanonicalSentinelVerdict(buildCanonicalSentinelVerdict(current));

    expect(current).toEqual(before);
    expect(current.verdict).toBe('BLOCK');
    expect(current.meta.promotion).toEqual(before.meta.promotion);
    expect(v1Again).toBe(v1);
    expect(v1).not.toContain('mandateDigest');
    expect(v1).not.toContain('actionDigest');
    expect(v1).not.toContain(commitments!.digestSalt);
    expect(v2.verdict).toBe(current.verdict);
    expect(v2.artifactSchema).toBe('sentinel.verdict.canonical.v2');
    expect(v2.mandateDigest).toBe(commitments?.mandateDigest);
    expect(v2.actionDigest).toBe(commitments?.actionDigest);

    const serialized = serializeCanonicalSentinelVerdict(v2);
    expect(serialized).not.toContain(commitments!.digestSalt);
    expect(JSON.parse(serialized).verdict).toBe('BLOCK');

    current.meta.digest_salt = commitments!.digestSalt;
    expect(serializeCanonicalSentinelVerdict(buildCanonicalSentinelVerdict(current))).toBe(v1);
  });

  it('does not accept a malformed digest string and still emits the rest of v2', () => {
    const body = buildCanonicalSentinelVerdictV2(response(), {
      potCli: '0.8.12',
      mandateDigest: 'sha256:NOT-HEX',
      actionDigest: `sha256:${'ab'.repeat(32)}`,
    });
    expect(body.mandateDigest).toBeUndefined();
    expect(body.actionDigest).toBe(`sha256:${'ab'.repeat(32)}`);
    expect(body.potCli).toBe('0.8.12');
    expect(body.verdict).toBe('BLOCK');
    expect(body.releaseId).toBe('da6b6378e105d0c7e1f810bbe237d2f23c55c103');
  });

  it('returns the salt only when the issued v2 body carries a digest', () => {
    const commitments = computeMandateActionCommitments(mandate, SALT)!;
    const withDigest = serializeCanonicalSentinelVerdict(
      buildCanonicalSentinelVerdictV2(response(), {
        potCli: '0.8.12',
        mandateDigest: commitments.mandateDigest,
        actionDigest: commitments.actionDigest,
      }),
    );
    expect(digestSaltIfCommitted(withDigest, commitments.digestSalt)).toBe(commitments.digestSalt);
    expect(responseDigestSalt({ canonical: withDigest }, commitments.digestSalt)).toBe(
      commitments.digestSalt,
    );
    const without = serializeCanonicalSentinelVerdict(
      buildCanonicalSentinelVerdictV2(response(), { potCli: '0.8.12' }),
    );
    expect(digestSaltIfCommitted(without, commitments.digestSalt)).toBeUndefined();
    expect(responseDigestSalt(null, commitments.digestSalt)).toBeUndefined();
    expect(digestSaltIfCommitted(withDigest, 'AA'.repeat(32))).toBeUndefined();
    expect(digestSaltIfCommitted(withDigest, 'abcd')).toBeUndefined();
  });

  it('leaves the public receipt allowlist without the salt or the digests', () => {
    expect(SUITE_RECEIPT_ALLOWLIST.meta).not.toContain('digest_salt');
    expect(SUITE_RECEIPT_ALLOWLIST.receipt).not.toContain('signed_export_v2');
    expect(SUITE_RECEIPT_ALLOWLIST.receipt).not.toContain('mandateDigest');
    expect(SUITE_RECEIPT_ALLOWLIST.receipt).not.toContain('actionDigest');
    const flat = JSON.stringify(SUITE_RECEIPT_ALLOWLIST);
    expect(flat).not.toContain('digest_salt');
    expect(flat).not.toContain('mandateDigest');
    expect(flat).not.toContain('actionDigest');

    const salt = 'ab'.repeat(32);
    const mandateDigest = `sha256:${'cd'.repeat(32)}`;
    const actionDigest = `sha256:${'ef'.repeat(32)}`;
    const redacted = redactSuiteReceipt({
      verdict: 'BLOCK',
      meta: { digest_salt: salt, pot_cli: '0.8.12', mandate_digest: mandateDigest },
      mandateDigest,
      actionDigest,
      signed_export_v2: {
        canonical: JSON.stringify({ mandateDigest, actionDigest, digest_salt: salt }),
        signature: '0x' + '1'.repeat(128),
      },
    });
    const archived = JSON.stringify(redacted);
    expect(archived).not.toContain(salt);
    expect(archived).not.toContain(mandateDigest);
    expect(archived).not.toContain(actionDigest);
    expect(archived).not.toContain('digest_salt');
    expect(redacted.receipt.meta.pot_cli).toBe('0.8.12');
    expect(redacted.receipt.verdict).toBe('BLOCK');
    expect(redacted.receipt).not.toHaveProperty('signed_export_v2');
  });
});

describe('portable commitment recompute', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    clearExportSignerReadinessCache();
  });

  function writeKeys(x: string): string {
    const path = join(dir, 'keys.json');
    writeFileSync(
      path,
      JSON.stringify({
        schema: 'thoughtproof.keys.v1',
        keys: [{
          kty: 'OKP',
          crv: 'Ed25519',
          x,
          kid: 'local-commitment-ed25519',
          alg: 'EdDSA',
          status: 'active',
          notBefore: '2020-01-01T00:00:00Z',
          notAfter: null,
        }],
      }),
    );
    return path;
  }

  function run(args: string[]) {
    return spawnSync(process.execPath, ['scripts/verify-canonical-export.mjs', ...args], {
      encoding: 'utf8',
    });
  }

  it('detects a tampered mandate or action and accepts the original JSON', () => {
    dir = mkdtempSync(join(tmpdir(), 'salted-commitment-'));
    const { privateKey, publicKeyOkpX } = generateExportKeyPair();
    const keys = writeKeys(publicKeyOkpX);
    const commitments = computeMandateActionCommitments(mandate, SALT)!;
    const current = response();
    const before = structuredClone(current);
    const v1 = issueSignedCanonicalExport(current, {
      privateKey,
      keyId: 'local-commitment-ed25519',
      nowSeconds: SIGNED_AT,
    });
    const v2 = issueSignedCanonicalExport(
      buildCanonicalSentinelVerdictV2(current, {
        potCli: '0.8.12',
        mandateDigest: commitments.mandateDigest,
        actionDigest: commitments.actionDigest,
      }),
      { privateKey, keyId: 'local-commitment-ed25519', nowSeconds: SIGNED_AT },
    );
    expect(current).toEqual(before);
    expect(current.verdict).toBe('BLOCK');
    expect(v1.artifactSchema).toBe('sentinel.verdict.canonical.v1');
    expect(v1.canonical).not.toContain('mandateDigest');
    expect(v2.canonical).not.toContain(commitments.digestSalt);

    const exportPath = join(dir, 'export.json');
    const mandatePath = join(dir, 'mandate.json');
    const actionPath = join(dir, 'action.json');
    writeFileSync(exportPath, JSON.stringify(v2));
    writeFileSync(mandatePath, JSON.stringify(mandate));
    writeFileSync(actionPath, JSON.stringify(mandate.action));
    const base = [
      exportPath,
      '--keys',
      keys,
      '--now',
      String(SIGNED_AT),
      '--schema',
      'v2',
    ];

    const ok = run([
      ...base,
      '--mandate',
      mandatePath,
      '--action',
      actionPath,
      '--digest-salt',
      commitments.digestSalt,
    ]);
    expect(ok.status).toBe(0);
    const okBody = JSON.parse(ok.stdout) as {
      ok: boolean;
      commitment_check: { ok: boolean; fields: string[] };
    };
    expect(okBody.ok).toBe(true);
    expect(okBody.commitment_check.fields).toEqual(['mandateDigest', 'actionDigest']);

    const plain = run(base);
    expect(plain.status).toBe(0);
    expect(JSON.parse(plain.stdout)).not.toHaveProperty('commitment_check');

    writeFileSync(
      mandatePath,
      JSON.stringify({ ...mandate, granted: { ...mandate.granted, maxAmount: 2000 } }),
    );
    const tamperedMandate = run([
      ...base,
      '--mandate',
      mandatePath,
      '--action',
      actionPath,
      '--digest-salt',
      commitments.digestSalt,
    ]);
    expect(tamperedMandate.status).not.toBe(0);
    expect(JSON.parse(tamperedMandate.stdout).error).toBe('commitment_mismatch');
    expect(tamperedMandate.stdout).not.toContain(commitments.digestSalt);
    expect(tamperedMandate.stdout).not.toContain('2000');

    writeFileSync(mandatePath, JSON.stringify(mandate));
    writeFileSync(actionPath, JSON.stringify({ ...mandate.action, amount: 1 }));
    const tamperedAction = run([
      ...base,
      '--mandate',
      mandatePath,
      '--action',
      actionPath,
      '--digest-salt',
      commitments.digestSalt,
    ]);
    expect(tamperedAction.status).not.toBe(0);
    expect(JSON.parse(tamperedAction.stdout).error).toBe('commitment_mismatch');
    expect(JSON.parse(tamperedAction.stdout).field).toBe('actionDigest');

    const missingSalt = run([...base, '--mandate', mandatePath]);
    expect(missingSalt.status).not.toBe(0);
    expect(JSON.parse(missingSalt.stdout).error).toBe('commitment_input_incomplete');

    const v1Path = join(dir, 'v1.json');
    writeFileSync(v1Path, JSON.stringify(v1));
    const v1Check = run([
      v1Path,
      '--keys',
      keys,
      '--now',
      String(SIGNED_AT),
      '--mandate',
      mandatePath,
      '--digest-salt',
      commitments.digestSalt,
    ]);
    expect(v1Check.status).not.toBe(0);
    expect(JSON.parse(v1Check.stdout).error).toBe('commitment_schema_unsupported');
  });

  it('fails closed when a signed v2 body has no digest for the supplied mandate', () => {
    dir = mkdtempSync(join(tmpdir(), 'salted-commitment-missing-'));
    const mandatePath = join(dir, 'mandate.json');
    writeFileSync(mandatePath, JSON.stringify(mandate));
    const result = run([
      'scripts/fixtures/m1-export-v2/export-v2-valid.json',
      '--keys',
      'data/thoughtproof-keys.json',
      '--now',
      '1782916498',
      '--allow-vector-only',
      '--mandate',
      mandatePath,
      '--digest-salt',
      '11'.repeat(32),
    ]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout).error).toBe('commitment_missing');
    expect(JSON.parse(result.stdout).field).toBe('mandateDigest');
  });

  it('issues v2 commitments without changing the v1 signature', () => {
    const seed = 'cd'.repeat(32);
    const env = {
      SENTINEL_EXPORT_PRIVATE_KEY: seed,
      SENTINEL_EXPORT_KEY_ID: 'commitment-test-kid',
    };
    const load = { requirePublishedMatch: false as const };
    const current = response();
    const promotion = structuredClone(current.meta.promotion);
    clearExportSignerReadinessCache();
    const v1 = maybeIssueSignedExport(current, env, SIGNED_AT, load);
    const commitments = computeMandateActionCommitments(mandate, SALT)!;
    const v2 = maybeIssueSignedExportV2(current, env, SIGNED_AT, load, {
      mandateDigest: commitments.mandateDigest,
      actionDigest: commitments.actionDigest,
    });
    clearExportSignerReadinessCache();
    const v1Again = maybeIssueSignedExport(current, env, SIGNED_AT, load);
    expect(v1).toEqual(v1Again);
    expect(current.verdict).toBe('BLOCK');
    expect(current.meta.promotion).toEqual(promotion);
    expect(v1?.artifactSchema).toBe('sentinel.verdict.canonical.v1');
    expect(JSON.parse(v2!.canonical).mandateDigest).toBe(commitments.mandateDigest);
    expect(JSON.parse(v2!.canonical).actionDigest).toBe(commitments.actionDigest);
    expect(JSON.parse(v2!.canonical).verdict).toBe('BLOCK');
    expect(responseDigestSalt(v2, commitments.digestSalt)).toBe(commitments.digestSalt);
  });
});
