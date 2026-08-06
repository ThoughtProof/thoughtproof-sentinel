import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  issueSignFromVerifyResponse,
  verifyIssuedSignAttestation,
  isSignIssuanceConfigured,
  signCanonicalBody,
} from './issue-sign.js';
import { buildCanonicalSentinelVerdict } from './canonical-verdict.js';
import type { SentinelVerifyResponse } from './types.js';

function makeResponse(overrides: Partial<SentinelVerifyResponse> = {}): SentinelVerifyResponse {
  return {
    id: 'sent_test_l1_001',
    verdict: 'BLOCK',
    confidence: 0,
    reasoning: 'failScore=3 primary_block',
    objections: [
      {
        step_id: 'step_0',
        criterion: 'Thresholds',
        score: 0.1,
        predicate: 'unsupported',
        quote: 'drawdown 9.5%',
        reasoning: 'Drawdown exceeds mandate limit.',
      },
    ],
    mode: 'trade_execution',
    tier: 'standard',
    meta: {
      duration_ms: 1200,
      models_used: ['serv-nano', 'serv-swift'],
      verified_at: '2026-08-06T20:00:00.000Z',
    },
    ...overrides,
  };
}

describe('issue-sign L1', () => {
  const prevPem = process.env.VALIDATION_ED25519_PRIVATE_KEY_PEM;
  const prevPath = process.env.VALIDATION_ED25519_PRIVATE_KEY_PATH;
  let publicPem = '';
  let privatePem = '';

  beforeAll(() => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.VALIDATION_ED25519_PRIVATE_KEY_PEM = privatePem;
    delete process.env.VALIDATION_ED25519_PRIVATE_KEY_PATH;
  });

  afterAll(() => {
    if (prevPem === undefined) delete process.env.VALIDATION_ED25519_PRIVATE_KEY_PEM;
    else process.env.VALIDATION_ED25519_PRIVATE_KEY_PEM = prevPem;
    if (prevPath === undefined) delete process.env.VALIDATION_ED25519_PRIVATE_KEY_PATH;
    else process.env.VALIDATION_ED25519_PRIVATE_KEY_PATH = prevPath;
  });

  it('reports configured when PEM present', () => {
    expect(isSignIssuanceConfigured()).toBe(true);
  });

  it('signs canonical body and verifies with matching public key', () => {
    const att = issueSignFromVerifyResponse(makeResponse(), {
      claim_hash: '0xabc',
      evidence_hash: '0xdef',
    });
    expect(att.issued).toBe(true);
    expect(att.level).toBe('jws-ed25519');
    expect(att.verificationId).toBe('sent_test_l1_001');
    expect(att.canonical.verdict).toBe('BLOCK');
    expect(att.signature.alg).toBe('Ed25519');
    expect(att.signature.value.startsWith('0x')).toBe(true);
    expect(att.claim_hash).toBe('0xabc');

    const v = verifyIssuedSignAttestation(att, publicPem);
    expect(v).toEqual({ ok: true });
  });

  it('fails verify if canonical is tampered', () => {
    const att = issueSignFromVerifyResponse(makeResponse());
    att.canonical.verdict = 'ALLOW';
    const v = verifyIssuedSignAttestation(att, publicPem);
    expect(v.ok).toBe(false);
  });

  it('is deterministic for same response body', () => {
    const body = buildCanonicalSentinelVerdict(makeResponse());
    const a = signCanonicalBody(body);
    const b = signCanonicalBody(body);
    expect(a.canonicalHash).toBe(b.canonicalHash);
    expect(a.canonicalJson).toBe(b.canonicalJson);
    // signatures differ (non-deterministic pure ed25519? actually ed25519 is deterministic)
    expect(a.signature.value).toBe(b.signature.value);
  });
});
