/**
 * Test verdict downgrade-only enforcement - critical security property
 *
 * Fixtures use REAL ed25519 signatures: to reach the UNCERTAIN branch
 * (manifest unverifiable), the signature must verify first — a fake
 * signature always fails earlier as evidence_signature_invalid (BLOCK).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import canonicalizePkg from 'canonicalize';
import { processSignedEvidence, applyEvidenceEffects } from './evidence-processing.js';
import type { SentinelVerifyRequest, SentinelVerifyResponse } from './types.js';

const canonicalize = canonicalizePkg as unknown as (v: unknown) => string;

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const signerPubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
  .subarray(-32)
  .toString('hex');

function makeSignedRawEvent(payload: unknown): string {
  const message = Buffer.from(canonicalize(payload), 'utf8');
  const signature = cryptoSign(null, message, privateKey).toString('hex');
  return Buffer.from(JSON.stringify({ payload, signature }), 'utf8').toString('base64');
}

describe('verdict-downgrade-only', () => {
  const createMockResponse = (verdict: 'ALLOW' | 'BLOCK' | 'UNCERTAIN'): SentinelVerifyResponse => ({
    id: "test_123",
    verdict,
    confidence: 0.95,
    reasoning: "Original verdict reasoning",
    mode: "action_authorization",
    tier: "standard",
    objections: [],
    meta: {
      duration_ms: 1200,
      models_used: ["serv-nano"],
      verified_at: "2026-08-02T12:00:00Z"
    }
  });

  const createRequestWithFailedEvidence = (): SentinelVerifyRequest => ({
    claim: "Transfer $100",
    evidence: "Evidence with critical failure",
    mode: "action_authorization",
    signed_evidence: [
      {
        type: 'signed_event',
        raw_event: 'invalid_base64_that_will_fail',
        signature_scheme: 'ed25519',
        signer_pubkey: 'fake_pubkey',
        claims: ['owner_signoff'],
        verification: 'required'
      }
    ]
  });

  // Valid signature + key_manifest_ref WITHOUT a supplied manifest → the verifier
  // cannot determine authorization → UNCERTAIN (never BLOCK-on-config, never ALLOW).
  const createRequestWithUncertainEvidence = (): SentinelVerifyRequest => ({
    claim: "Transfer $100",
    evidence: "Evidence with manifest issue",
    mode: "action_authorization",
    signed_evidence: [
      {
        type: 'signed_event',
        raw_event: makeSignedRawEvent({ action: 'transfer', amount: 100 }),
        signature_scheme: 'ed25519',
        signer_pubkey: signerPubkey,
        key_manifest_ref: 'some_manifest_that_does_not_exist',
        claims: ['owner_signoff'],
        verification: 'required'
      }
    ]
  });

  describe('BLOCK forcing (critical failures)', () => {
    it('should force ALLOW -> BLOCK when evidence signature fails', () => {
      const originalResponse = createMockResponse('ALLOW');
      const request = createRequestWithFailedEvidence();

      const evidenceResult = processSignedEvidence(request);
      const modifiedResponse = applyEvidenceEffects(originalResponse, evidenceResult, request);

      expect(evidenceResult.shouldForceVerdict).toBe(true);
      expect(evidenceResult.forcedVerdict).toBe('BLOCK');
      expect(modifiedResponse.verdict).toBe('BLOCK');
      expect(modifiedResponse.reasoning).toContain('Evidence verification failed');
    });

    it('should force UNCERTAIN -> BLOCK when evidence signature fails', () => {
      const originalResponse = createMockResponse('UNCERTAIN');
      const request = createRequestWithFailedEvidence();

      const evidenceResult = processSignedEvidence(request);
      const modifiedResponse = applyEvidenceEffects(originalResponse, evidenceResult, request);

      expect(modifiedResponse.verdict).toBe('BLOCK');
    });

    it('should leave BLOCK unchanged when evidence fails (no upgrade)', () => {
      const originalResponse = createMockResponse('BLOCK');
      const request = createRequestWithFailedEvidence();

      const evidenceResult = processSignedEvidence(request);
      const modifiedResponse = applyEvidenceEffects(originalResponse, evidenceResult, request);

      expect(modifiedResponse.verdict).toBe('BLOCK');
      expect(modifiedResponse.reasoning).toContain('Evidence verification failed');
    });
  });

  describe('UNCERTAIN forcing (non-critical failures)', () => {
    it('should force ALLOW -> UNCERTAIN for manifest issues', () => {
      const originalResponse = createMockResponse('ALLOW');
      const request = createRequestWithUncertainEvidence();

      const evidenceResult = processSignedEvidence(request);
      const modifiedResponse = applyEvidenceEffects(originalResponse, evidenceResult, request);

      expect(evidenceResult.shouldForceVerdict).toBe(true);
      expect(evidenceResult.forcedVerdict).toBe('UNCERTAIN');
      expect(evidenceResult.evidenceVerification[0].code).toBe('key_manifest_unverifiable');
      expect(modifiedResponse.verdict).toBe('UNCERTAIN');
      expect(modifiedResponse.reasoning).toContain('Evidence verification issues');
    });

    it('should NOT change BLOCK -> UNCERTAIN (no upgrade from BLOCK)', () => {
      const originalResponse = createMockResponse('BLOCK');
      const request = createRequestWithUncertainEvidence();

      const evidenceResult = processSignedEvidence(request);
      const modifiedResponse = applyEvidenceEffects(originalResponse, evidenceResult, request);

      expect(modifiedResponse.verdict).toBe('BLOCK');
    });

    it('should NOT change UNCERTAIN -> UNCERTAIN (no change needed)', () => {
      const originalResponse = createMockResponse('UNCERTAIN');
      const request = createRequestWithUncertainEvidence();

      const evidenceResult = processSignedEvidence(request);
      const modifiedResponse = applyEvidenceEffects(originalResponse, evidenceResult, request);

      expect(modifiedResponse.verdict).toBe('UNCERTAIN');
    });
  });

  describe('No verdict upgrades allowed', () => {
    it('should never upgrade BLOCK to anything else', () => {
      const originalBlockResponse = createMockResponse('BLOCK');

      const validRequest: SentinelVerifyRequest = {
        claim: "Transfer $100",
        evidence: "Valid evidence",
        mode: "action_authorization",
        signed_evidence: [
          {
            type: 'signed_event',
            raw_event: makeSignedRawEvent({ action: 'transfer' }),
            signature_scheme: 'ed25519',
            signer_pubkey: signerPubkey,
            claims: ['owner_signoff'],
            verification: 'required'
          }
        ]
      };

      const evidenceResult = processSignedEvidence(validRequest);
      const modifiedResponse = applyEvidenceEffects(originalBlockResponse, evidenceResult, validRequest);

      expect(evidenceResult.shouldForceVerdict).toBe(false);
      expect(modifiedResponse.verdict).toBe('BLOCK');
    });
  });

  describe('backward compatibility (steelman C2)', () => {
    it('should NOT add F1 meta fields for requests without signed_evidence', () => {
      const originalResponse = createMockResponse('ALLOW');
      const cleanRequest: SentinelVerifyRequest = {
        claim: 'Transfer $100',
        evidence: 'plain evidence',
        mode: 'handoff',
      };

      const evidenceResult = processSignedEvidence(cleanRequest);
      const modifiedResponse = applyEvidenceEffects(originalResponse, evidenceResult, cleanRequest);

      expect(modifiedResponse.meta.package_digest).toBeUndefined();
      expect(modifiedResponse.meta.proof_strength).toBeUndefined();
      expect(modifiedResponse.meta.evidence_verification).toBeUndefined();
      expect(modifiedResponse.verdict).toBe('ALLOW');
      expect(modifiedResponse.reasoning).toBe('Original verdict reasoning');
    });
  });
});
