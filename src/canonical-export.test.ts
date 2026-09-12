import { createPublicKey } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  buildExportSignedInput,
  digestTransportedCanonical,
  generateExportKeyPair,
  issueSignedCanonicalExport,
  loadExportSignerFromEnv,
  maybeIssueSignedExport,
  publicKeyPem,
  publicKeyRawHex,
  verifySignedCanonicalExport,
  EXPORT_DOMAIN,
  EXPORT_ALG,
} from './canonical-export.js';
import {
  buildCanonicalSentinelVerdict,
  hashCanonicalSentinelVerdict,
  serializeCanonicalSentinelVerdict,
} from './canonical-verdict.js';
import type { SentinelVerifyResponse } from './types.js';

function makeResponse(overrides: Partial<SentinelVerifyResponse> = {}): SentinelVerifyResponse {
  return {
    id: 'sent_9f3c2a7b1e004d68',
    verdict: 'ALLOW',
    confidence: 0.84,
    reasoning: 'All steps adequately supported by the evidence.',
    objections: [
      {
        step_id: 'step_0',
        criterion: 'Direction check',
        score: 0.9,
        predicate: 'supported',
        quote: null,
        reasoning: 'Direction claim verified against market data.',
      },
    ],
    mode: 'trade_execution',
    tier: 'standard',
    meta: {
      duration_ms: 1200,
      models_used: ['serv-nano', 'serv-swift'],
      verified_at: '2026-07-01T14:34:58.000Z',
    },
    ...overrides,
  };
}

// Public fixture JCS + hash from canonical-verdict (must stay locked)
const FIXTURE_JCS =
  '{"apiVersion":"sentinel-api-0.1.0","artifactSchema":"sentinel.verdict.canonical.v1","confidence":84,"evaluatedAt":1782916498,"mode":"trade_execution","models":{"primary":"serv-nano","secondary":"serv-swift"},"objections":["step_0: Direction claim verified against market data."],"reasoning":"All steps adequately supported by the evidence.","tier":"standard","verdict":"ALLOW","verificationId":"sent_9f3c2a7b1e004d68"}';
const FIXTURE_HASH =
  '0x419c360db82ee72be3411acd2d30f560b3f62842c2162fa3cb4a08c1fa4ce65a';

describe('canonical-export M1 envelope', () => {
  it('fixture canonical still matches committed JCS + digest', () => {
    const body = buildCanonicalSentinelVerdict(makeResponse());
    expect(serializeCanonicalSentinelVerdict(body)).toBe(FIXTURE_JCS);
    expect(hashCanonicalSentinelVerdict(body)).toBe(FIXTURE_HASH);
    expect(digestTransportedCanonical(FIXTURE_JCS)).toBe(FIXTURE_HASH);
  });

  it('issues a verifiable export; digest binds transported canonical', () => {
    const { privateKey, publicKey } = generateExportKeyPair();
    const exp = issueSignedCanonicalExport(makeResponse(), {
      privateKey,
      keyId: 'test-kid-1',
      nowSeconds: 1_780_000_000,
    });
    expect(exp.exportSchema).toBe(EXPORT_DOMAIN);
    expect(exp.alg).toBe(EXPORT_ALG);
    expect(exp.canonical).toBe(FIXTURE_JCS);
    expect(exp.digest).toBe(FIXTURE_HASH);
    expect(exp.keyId).toBe('test-kid-1');
    expect(exp.signedAt).toBe(1_780_000_000);
    expect(exp.validUntil).toBeUndefined();
    expect(exp.signature).toMatch(/^0x[0-9a-f]{128}$/);

    const v = verifySignedCanonicalExport(exp, publicKey);
    expect(v).toEqual({
      ok: true,
      recomputedDigest: FIXTURE_HASH,
      keyId: 'test-kid-1',
    });
  });

  it('detects digest mismatch without re-running verify (artifact lock)', () => {
    const { privateKey, publicKey } = generateExportKeyPair();
    const exp = issueSignedCanonicalExport(makeResponse(), {
      privateKey,
      keyId: 'test-kid-1',
      nowSeconds: 1_780_000_000,
    });
    // Attacker swaps canonical string but leaves old digest — signature may still
    // fail first depending on order; we check digest before accepting.
    const tampered = {
      ...exp,
      canonical: exp.canonical.replace('"ALLOW"', '"BLOCK"'),
    };
    const v = verifySignedCanonicalExport(tampered, publicKey);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('digest_mismatch');
    expect(v.recomputedDigest).not.toBe(exp.digest);
  });

  it('detects signature break when digest+canonical stay consistent but envelope fields change', () => {
    const { privateKey, publicKey } = generateExportKeyPair();
    const exp = issueSignedCanonicalExport(makeResponse(), {
      privateKey,
      keyId: 'test-kid-1',
      nowSeconds: 1_780_000_000,
      ttlSeconds: 3600,
    });
    // Stretch validUntil unsigned — must fail signature
    const stretched = { ...exp, validUntil: exp.validUntil! + 86_400 };
    const v = verifySignedCanonicalExport(stretched, publicKey);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('signature_invalid');
  });

  it('rejects wrong public key', () => {
    const a = generateExportKeyPair();
    const b = generateExportKeyPair();
    const exp = issueSignedCanonicalExport(makeResponse(), {
      privateKey: a.privateKey,
      keyId: 'a',
      nowSeconds: 100,
    });
    const v = verifySignedCanonicalExport(exp, b.publicKey);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('signature_invalid');
  });

  it('enforces validUntil when present', () => {
    const { privateKey, publicKey } = generateExportKeyPair();
    const exp = issueSignedCanonicalExport(makeResponse(), {
      privateKey,
      keyId: 'k',
      nowSeconds: 1_000,
      ttlSeconds: 60,
    });
    expect(exp.validUntil).toBe(1_060);
    expect(verifySignedCanonicalExport(exp, publicKey, { nowSeconds: 1_060 }).ok).toBe(true);
    const expired = verifySignedCanonicalExport(exp, publicKey, { nowSeconds: 1_061 });
    expect(expired.ok).toBe(false);
    expect(expired.code).toBe('expired');
  });

  it('omits validUntil from signed input when not set (JCS absent ≠ null)', () => {
    const fields = {
      artifactSchema: 'sentinel.verdict.canonical.v1' as const,
      verificationId: 'sent_x',
      canonical: '{}',
      digest: '0x' + 'ab'.repeat(32),
      keyId: 'k',
      alg: EXPORT_ALG,
      signedAt: 1,
    };
    const withOmit = buildExportSignedInput(fields).toString('utf8');
    expect(withOmit.includes('validUntil')).toBe(false);
    const withVu = buildExportSignedInput({ ...fields, validUntil: 99 }).toString('utf8');
    expect(withVu.includes('validUntil')).toBe(true);
  });

  it('does not put validUntil into the canonical body (v1 digest stable)', () => {
    const { privateKey } = generateExportKeyPair();
    const exp = issueSignedCanonicalExport(makeResponse(), {
      privateKey,
      keyId: 'k',
      nowSeconds: 50,
      ttlSeconds: 10,
    });
    expect(exp.canonical).toBe(FIXTURE_JCS);
    expect(exp.digest).toBe(FIXTURE_HASH);
    expect(JSON.parse(exp.canonical).validUntil).toBeUndefined();
  });

  it('loadExportSignerFromEnv returns null when unset', () => {
    expect(loadExportSignerFromEnv({})).toBeNull();
    expect(maybeIssueSignedExport(makeResponse(), {})).toBeNull();
  });

  it('loadExportSignerFromEnv accepts raw 32-byte seed hex', () => {
    const seed = '11'.repeat(32);
    const loaded = loadExportSignerFromEnv({
      SENTINEL_EXPORT_PRIVATE_KEY: seed,
      SENTINEL_EXPORT_KEY_ID: 'seed-kid',
      SENTINEL_EXPORT_TTL_SECONDS: '120',
    });
    expect(loaded).not.toBeNull();
    expect(loaded!.keyId).toBe('seed-kid');
    expect(loaded!.ttlSeconds).toBe(120);
    const exp = issueSignedCanonicalExport(makeResponse(), {
      privateKey: loaded!.privateKey,
      keyId: loaded!.keyId,
      ttlSeconds: loaded!.ttlSeconds,
      nowSeconds: 10,
    });
    const pub = createPublicKey(loaded!.privateKey);
    const verified = verifySignedCanonicalExport(exp, pub, { nowSeconds: 10 });
    expect(verified).toEqual({
      ok: true,
      recomputedDigest: exp.digest,
      keyId: 'seed-kid',
    });
    expect(exp.validUntil).toBe(130);
    expect(publicKeyRawHex(pub)).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyPem(pub)).toContain('BEGIN PUBLIC KEY');
  });

  it('digest identifies one issued artifact — fresh body with same claim ≠ same export', () => {
    const { privateKey, publicKey } = generateExportKeyPair();
    const a = issueSignedCanonicalExport(makeResponse({ id: 'sent_a' }), {
      privateKey,
      keyId: 'k',
      nowSeconds: 1,
    });
    const b = issueSignedCanonicalExport(makeResponse({ id: 'sent_b' }), {
      privateKey,
      keyId: 'k',
      nowSeconds: 1,
    });
    expect(a.digest).not.toBe(b.digest);
    expect(a.verificationId).toBe('sent_a');
    expect(b.verificationId).toBe('sent_b');
    // Verifying B's signature against A's canonical must fail digest path if swapped
    const swapped = { ...a, canonical: b.canonical, digest: b.digest };
    expect(verifySignedCanonicalExport(swapped, publicKey).ok).toBe(false);
  });
});
