/**
 * Tests for Package Digest Computation (F1)
 */

import { describe, it, expect } from 'vitest';
import { computePackageDigest, verifyPackageDigest } from './package-digest.js';
import type { SentinelVerifyRequest } from './types.js';

describe('package-digest', () => {
  describe('computePackageDigest', () => {
    it('should compute deterministic hash for same request', () => {
      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
        tier: 'standard',
      };

      const digest1 = computePackageDigest(request);
      const digest2 = computePackageDigest(request);

      expect(digest1).toBe(digest2);
      expect(digest1).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('should produce different hashes for different requests', () => {
      const request1: SentinelVerifyRequest = {
        claim: 'Test claim 1',
        evidence: 'Test evidence',
        mode: 'handoff',
      };

      const request2: SentinelVerifyRequest = {
        claim: 'Test claim 2',
        evidence: 'Test evidence',
        mode: 'handoff',
      };

      const digest1 = computePackageDigest(request1);
      const digest2 = computePackageDigest(request2);

      expect(digest1).not.toBe(digest2);
    });

    it('should ignore undefined fields for determinism', () => {
      const request1: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
      };

      const request2: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
        id: undefined, // Should be ignored
        tier: undefined, // Should be ignored
      };

      const digest1 = computePackageDigest(request1);
      const digest2 = computePackageDigest(request2);

      expect(digest1).toBe(digest2);
    });

    it('should handle nested objects deterministically', () => {
      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
        agent_context: {
          agent_id: 'test-agent',
          environment: 'dev',
        },
      };

      const digest1 = computePackageDigest(request);
      const digest2 = computePackageDigest(request);

      expect(digest1).toBe(digest2);
    });

    it('should handle signed evidence array', () => {
      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
        signed_evidence: [
          {
            type: 'signed_event',
            raw_event: 'base64data',
            signature_scheme: 'ed25519',
            signer_pubkey: 'abcd1234',
            claims: ['owner_signoff'],
            verification: 'required',
          },
        ],
      };

      const digest = computePackageDigest(request);
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe('verifyPackageDigest', () => {
    it('should verify matching digest', () => {
      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
      };

      const digest = computePackageDigest(request);
      const isValid = verifyPackageDigest(request, digest);

      expect(isValid).toBe(true);
    });

    it('should reject non-matching digest', () => {
      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
      };

      const fakeDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
      const isValid = verifyPackageDigest(request, fakeDigest);

      expect(isValid).toBe(false);
    });

    it('should reject invalid digest format', () => {
      const request: SentinelVerifyRequest = {
        claim: 'Test claim',
        evidence: 'Test evidence',
        mode: 'handoff',
      };

      const invalidDigest = 'invalid-digest';
      const isValid = verifyPackageDigest(request, invalidDigest);

      expect(isValid).toBe(false);
    });
  });
});