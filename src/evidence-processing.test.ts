/**
 * Tests for Evidence Processing (F1)
 */

import { describe, it, expect } from 'vitest';
import { processSignedEvidence, applyEvidenceEffects } from './evidence-processing.js';
import type { SentinelVerifyRequest, SentinelVerifyResponse } from './types.js';

describe('evidence-processing', () => {
  describe('processSignedEvidence', () => {
    it('should return supplied_evidence when no signed evidence', () => {
      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
      };

      const result = processSignedEvidence(request);

      expect(result.shouldForceVerdict).toBe(false);
      expect(result.evidenceVerification).toHaveLength(0);
      expect(result.proofStrength).toBe('supplied_evidence');
      expect(result.additionalObjections).toHaveLength(0);
    });

    it('should handle invalid signature scheme', () => {
      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
        signed_evidence: [
          {
            type: 'signed_event',
            raw_event: Buffer.from(JSON.stringify({ payload: {}, signature: 'fake' })).toString('base64'),
            signature_scheme: 'secp256k1' as any,
            signer_pubkey: 'fake',
            claims: ['owner_signoff'],
            verification: 'required',
          },
        ],
      };

      const result = processSignedEvidence(request);

      expect(result.shouldForceVerdict).toBe(true);
      expect(result.forcedVerdict).toBe('BLOCK');
      expect(result.evidenceVerification).toHaveLength(1);
      expect(result.evidenceVerification[0].status).toBe('failed');
      expect(result.proofStrength).toBe('supplied_evidence');
    });

    it('should handle invalid base64 in raw_event', () => {
      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
        signed_evidence: [
          {
            type: 'signed_event',
            raw_event: 'invalid-base64!',
            signature_scheme: 'ed25519',
            signer_pubkey: 'abcd1234' + '0'.repeat(56), // 64 chars
            claims: ['owner_signoff'],
            verification: 'required',
          },
        ],
      };

      const result = processSignedEvidence(request);

      // Malformed evidence = invalid evidence → BLOCK (fail-closed, steelman C1 fix).
      expect(result.shouldForceVerdict).toBe(true);
      expect(result.forcedVerdict).toBe('BLOCK');
      expect(result.evidenceVerification).toHaveLength(1);
      expect(result.evidenceVerification[0].status).toBe('failed');
      expect(result.evidenceVerification[0].severity).toBe('block');
      expect(result.evidenceVerification[0].code).toBe('evidence_malformed');
      expect(result.proofStrength).toBe('supplied_evidence');
    });

    it('should add evidence objections for failures', () => {
      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
        signed_evidence: [
          {
            type: 'signed_event',
            raw_event: 'invalid-base64!',
            signature_scheme: 'ed25519',
            signer_pubkey: 'abcd1234' + '0'.repeat(56),
            claims: ['owner_signoff'],
            verification: 'required',
          },
        ],
      };

      const result = processSignedEvidence(request);

      expect(result.additionalObjections).toHaveLength(1);
      expect(result.additionalObjections[0].step_id).toBe('evidence_0');
      expect(result.additionalObjections[0].predicate).toBe('unsupported');
      expect(result.additionalObjections[0].reasoning).toContain('evidence_malformed');
    });

    it('should handle optional evidence without forcing verdict', () => {
      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
        signed_evidence: [
          {
            type: 'signed_event',
            raw_event: 'invalid-base64!',
            signature_scheme: 'ed25519',
            signer_pubkey: 'abcd1234' + '0'.repeat(56),
            claims: ['owner_signoff'],
            verification: 'optional', // Optional, so no verdict forcing
          },
        ],
      };

      const result = processSignedEvidence(request);

      expect(result.shouldForceVerdict).toBe(false);
      expect(result.evidenceVerification).toHaveLength(1);
      expect(result.evidenceVerification[0].status).toBe('failed');
      expect(result.proofStrength).toBe('supplied_evidence');
    });
  });

  describe('applyEvidenceEffects', () => {
    it('should preserve original verdict when no forcing', () => {
      const originalResponse: SentinelVerifyResponse = {
        id: 'test-123',
        verdict: 'ALLOW',
        confidence: 0.9,
        reasoning: 'Original reasoning',
        objections: [],
        mode: 'handoff',
        tier: 'standard',
        meta: {
          duration_ms: 100,
          models_used: ['model1'],
          verified_at: new Date().toISOString(),
        },
      };

      const processingResult = {
        shouldForceVerdict: false,
        additionalObjections: [],
        evidenceVerification: [],
        proofStrength: 'supplied_evidence' as const,
      };

      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
      };

      const result = applyEvidenceEffects(originalResponse, processingResult, request);

      expect(result.verdict).toBe('ALLOW');
      expect(result.reasoning).toBe('Original reasoning');
      // C2 backward compat: NO F1 meta fields when the request has no signed_evidence
      expect(result.meta.proof_strength).toBeUndefined();
      expect(result.meta.package_digest).toBeUndefined();
      expect(result.meta.evidence_verification).toBeUndefined();
    });

    it('should force BLOCK verdict on critical evidence failure', () => {
      const originalResponse: SentinelVerifyResponse = {
        id: 'test-123',
        verdict: 'ALLOW',
        confidence: 0.9,
        reasoning: 'Original reasoning',
        objections: [],
        mode: 'handoff',
        tier: 'standard',
        meta: {
          duration_ms: 100,
          models_used: ['model1'],
          verified_at: new Date().toISOString(),
        },
      };

      const processingResult = {
        shouldForceVerdict: true,
        forcedVerdict: 'BLOCK' as const,
        additionalObjections: [
          {
            step_id: 'evidence_0',
            criterion: 'Cryptographic evidence verification',
            score: 0.0,
            predicate: 'unsupported',
            quote: null,
            reasoning: 'Evidence signature verification failed',
          },
        ],
        evidenceVerification: [
          {
            index: 0,
            status: 'failed' as const,
            reason: 'Invalid signature',
          },
        ],
        proofStrength: 'supplied_evidence' as const,
      };

      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
      };

      const result = applyEvidenceEffects(originalResponse, processingResult, request);

      expect(result.verdict).toBe('BLOCK');
      expect(result.reasoning).toContain('Evidence verification failed');
      expect(result.reasoning).toContain('Original reasoning');
      expect(result.objections).toHaveLength(1);
      expect(result.meta.evidence_verification).toHaveLength(1);
    });

    it('should downgrade ALLOW to UNCERTAIN on non-critical failure', () => {
      const originalResponse: SentinelVerifyResponse = {
        id: 'test-123',
        verdict: 'ALLOW',
        confidence: 0.9,
        reasoning: 'Original reasoning',
        objections: [],
        mode: 'handoff',
        tier: 'standard',
        meta: {
          duration_ms: 100,
          models_used: ['model1'],
          verified_at: new Date().toISOString(),
        },
      };

      const processingResult = {
        shouldForceVerdict: true,
        forcedVerdict: 'UNCERTAIN' as const,
        additionalObjections: [],
        evidenceVerification: [],
        proofStrength: 'supplied_evidence' as const,
      };

      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
      };

      const result = applyEvidenceEffects(originalResponse, processingResult, request);

      expect(result.verdict).toBe('UNCERTAIN');
      expect(result.reasoning).toContain('Evidence verification issues detected');
    });

    it('should not downgrade BLOCK to UNCERTAIN', () => {
      const originalResponse: SentinelVerifyResponse = {
        id: 'test-123',
        verdict: 'BLOCK',
        confidence: 0.1,
        reasoning: 'Original block reasoning',
        objections: [],
        mode: 'handoff',
        tier: 'standard',
        meta: {
          duration_ms: 100,
          models_used: ['model1'],
          verified_at: new Date().toISOString(),
        },
      };

      const processingResult = {
        shouldForceVerdict: true,
        forcedVerdict: 'UNCERTAIN' as const, // Trying to downgrade to UNCERTAIN
        additionalObjections: [],
        evidenceVerification: [],
        proofStrength: 'supplied_evidence' as const,
      };

      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
      };

      const result = applyEvidenceEffects(originalResponse, processingResult, request);

      expect(result.verdict).toBe('BLOCK'); // Should remain BLOCK
      expect(result.reasoning).toBe('Original block reasoning');
    });
  });
});