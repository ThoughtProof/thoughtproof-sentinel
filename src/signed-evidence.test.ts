/**
 * Tests for Signed Evidence Verification (F1)
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'crypto';
import { verifySignedEvidence, type SignedEventEvidence, type KeyManifest } from './signed-evidence.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - canonicalize types are loose; runtime export is the function
import canonicalize from 'canonicalize';
import { createHash, sign as cryptoSign } from 'crypto';

/**
 * Generate ed25519 keypair for testing
 */
function generateTestKeyPair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/**
 * Extract raw 32-byte public key from PEM SPKI
 */
function extractEd25519PublicKey(pemPublicKey: string): string {
  // Create public key object from PEM and extract raw key
  const keyObject = createPublicKey(pemPublicKey);
  const derBuffer = keyObject.export({ type: 'spki', format: 'der' });
  // Ed25519 SPKI has 12-byte header + 32-byte key
  if (derBuffer.length !== 44) {
    throw new Error('Invalid Ed25519 SPKI length');
  }
  return derBuffer.subarray(12).toString('hex');
}

/**
 * Sign a payload with ed25519 private key
 */
function signPayload(payload: unknown, privateKeyPem: string): string {
  const canonical = (canonicalize as unknown as (v: unknown) => string)(payload);
  const message = Buffer.from(canonical, 'utf8');
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = cryptoSign(null, message, privateKey);
  return signature.toString('hex');
}

describe('signed-evidence', () => {
  describe('verifySignedEvidence', () => {
    it('should verify valid signed event', () => {
      const { publicKey, privateKey } = generateTestKeyPair();
      const pubkeyHex = extractEd25519PublicKey(publicKey);

      const payload = { action: 'transfer', amount: 100, to: 'alice' };
      const signature = signPayload(payload, privateKey);
      
      const rawEvent = { payload, signature };
      const rawEventBase64 = Buffer.from(JSON.stringify(rawEvent), 'utf8').toString('base64');

      const evidence: SignedEventEvidence = {
        type: 'signed_event',
        raw_event: rawEventBase64,
        signature_scheme: 'ed25519',
        signer_pubkey: pubkeyHex,
        claims: ['owner_signoff'],
        verification: 'required',
      };

      const results = verifySignedEvidence([evidence]);
      
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('recomputed');
      expect(results[0].signer).toBe(pubkeyHex);
      expect(results[0].claims_validated).toEqual(['owner_signoff']);
    });

    it('should fail on tampered payload', () => {
      const { publicKey, privateKey } = generateTestKeyPair();
      const pubkeyHex = extractEd25519PublicKey(publicKey);

      const payload = { action: 'transfer', amount: 100, to: 'alice' };
      const signature = signPayload(payload, privateKey);
      
      // Tamper with the payload after signing
      const tamperedPayload = { ...payload, amount: 1000 };
      const rawEvent = { payload: tamperedPayload, signature };
      const rawEventBase64 = Buffer.from(JSON.stringify(rawEvent), 'utf8').toString('base64');

      const evidence: SignedEventEvidence = {
        type: 'signed_event',
        raw_event: rawEventBase64,
        signature_scheme: 'ed25519',
        signer_pubkey: pubkeyHex,
        claims: ['owner_signoff'],
        verification: 'required',
      };

      const results = verifySignedEvidence([evidence]);
      
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
      expect(results[0].reason).toContain('Invalid signature');
    });

    it('should fail on revoked key with manifest', () => {
      const { publicKey, privateKey } = generateTestKeyPair();
      const pubkeyHex = extractEd25519PublicKey(publicKey);

      const payload = { action: 'transfer', amount: 100, to: 'alice' };
      const signature = signPayload(payload, privateKey);
      
      const rawEvent = { payload, signature };
      const rawEventBase64 = Buffer.from(JSON.stringify(rawEvent), 'utf8').toString('base64');

      const evidence: SignedEventEvidence = {
        type: 'signed_event',
        raw_event: rawEventBase64,
        signature_scheme: 'ed25519',
        signer_pubkey: pubkeyHex,
        claims: ['owner_signoff'],
        verification: 'required',
      };

      const manifest: KeyManifest = {
        version: '1',
        keys: [
          {
            pubkey: pubkeyHex,
            status: 'revoked', // Key is revoked
            roles: ['owner_signoff'],
          },
        ],
      };

      const results = verifySignedEvidence([evidence], manifest);
      
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
      expect(results[0].reason).toContain('revoked');
    });

    it('should fail on missing key in manifest', () => {
      const { publicKey, privateKey } = generateTestKeyPair();
      const pubkeyHex = extractEd25519PublicKey(publicKey);

      const payload = { action: 'transfer', amount: 100, to: 'alice' };
      const signature = signPayload(payload, privateKey);
      
      const rawEvent = { payload, signature };
      const rawEventBase64 = Buffer.from(JSON.stringify(rawEvent), 'utf8').toString('base64');

      const evidence: SignedEventEvidence = {
        type: 'signed_event',
        raw_event: rawEventBase64,
        signature_scheme: 'ed25519',
        signer_pubkey: pubkeyHex,
        claims: ['owner_signoff'],
        verification: 'required',
      };

      const manifest: KeyManifest = {
        version: '1',
        keys: [], // Empty manifest - key not found
      };

      const results = verifySignedEvidence([evidence], manifest);
      
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
      expect(results[0].reason).toContain('not found in manifest');
    });

    it('should succeed with active key and matching roles', () => {
      const { publicKey, privateKey } = generateTestKeyPair();
      const pubkeyHex = extractEd25519PublicKey(publicKey);

      const payload = { action: 'transfer', amount: 100, to: 'alice' };
      const signature = signPayload(payload, privateKey);
      
      const rawEvent = { payload, signature };
      const rawEventBase64 = Buffer.from(JSON.stringify(rawEvent), 'utf8').toString('base64');

      const evidence: SignedEventEvidence = {
        type: 'signed_event',
        raw_event: rawEventBase64,
        signature_scheme: 'ed25519',
        signer_pubkey: pubkeyHex,
        claims: ['owner_signoff'],
        verification: 'required',
      };

      const manifest: KeyManifest = {
        version: '1',
        keys: [
          {
            pubkey: pubkeyHex,
            status: 'active',
            roles: ['owner_signoff'],
          },
        ],
      };

      const results = verifySignedEvidence([evidence], manifest);
      
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('recomputed');
      expect(results[0].signer).toBe(pubkeyHex);
    });

    it('should fail on role mismatch', () => {
      const { publicKey, privateKey } = generateTestKeyPair();
      const pubkeyHex = extractEd25519PublicKey(publicKey);

      const payload = { action: 'transfer', amount: 100, to: 'alice' };
      const signature = signPayload(payload, privateKey);
      
      const rawEvent = { payload, signature };
      const rawEventBase64 = Buffer.from(JSON.stringify(rawEvent), 'utf8').toString('base64');

      const evidence: SignedEventEvidence = {
        type: 'signed_event',
        raw_event: rawEventBase64,
        signature_scheme: 'ed25519',
        signer_pubkey: pubkeyHex,
        claims: ['admin_action'], // Claiming admin role
        verification: 'required',
      };

      const manifest: KeyManifest = {
        version: '1',
        keys: [
          {
            pubkey: pubkeyHex,
            status: 'active',
            roles: ['owner_signoff'], // Only has owner role, not admin
          },
        ],
      };

      const results = verifySignedEvidence([evidence], manifest);
      
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
      expect(results[0].reason).toContain('do not authorize claims');
    });

    it('should fail on unsupported signature scheme', () => {
      const evidence: SignedEventEvidence = {
        type: 'signed_event',
        raw_event: Buffer.from(JSON.stringify({ payload: {}, signature: 'fake' })).toString('base64'),
        signature_scheme: 'secp256k1' as any, // Unsupported scheme
        signer_pubkey: 'fake',
        claims: ['owner_signoff'],
        verification: 'required',
      };

      const results = verifySignedEvidence([evidence]);
      
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
      expect(results[0].reason).toContain('Unsupported signature scheme');
    });

    it('should fail on invalid base64 raw_event', () => {
      const evidence: SignedEventEvidence = {
        type: 'signed_event',
        raw_event: 'invalid-base64!', 
        signature_scheme: 'ed25519',
        signer_pubkey: 'fake',
        claims: ['owner_signoff'],
        verification: 'required',
      };

      const results = verifySignedEvidence([evidence]);
      
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
      expect(results[0].reason).toContain('not valid base64 JSON');
    });

    it('should fail when manifest referenced but not provided', () => {
      const { publicKey, privateKey } = generateTestKeyPair();
      const pubkeyHex = extractEd25519PublicKey(publicKey);

      const payload = { action: 'transfer', amount: 100, to: 'alice' };
      const signature = signPayload(payload, privateKey);
      
      const rawEvent = { payload, signature };
      const rawEventBase64 = Buffer.from(JSON.stringify(rawEvent), 'utf8').toString('base64');

      const evidence: SignedEventEvidence = {
        type: 'signed_event',
        raw_event: rawEventBase64,
        signature_scheme: 'ed25519',
        signer_pubkey: pubkeyHex,
        key_manifest_ref: 'https://example.com/manifest.json', // Manifest referenced
        claims: ['owner_signoff'],
        verification: 'required',
      };

      // No manifest provided despite reference
      const results = verifySignedEvidence([evidence]);
      
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
      expect(results[0].reason).toContain('referenced but not provided');
    });

    it('should handle multiple evidence items', () => {
      const { publicKey: pubKey1, privateKey: privKey1 } = generateTestKeyPair();
      const { publicKey: pubKey2, privateKey: privKey2 } = generateTestKeyPair();
      
      const pubkeyHex1 = extractEd25519PublicKey(pubKey1);
      const pubkeyHex2 = extractEd25519PublicKey(pubKey2);

      const payload1 = { action: 'approve', amount: 100 };
      const payload2 = { action: 'execute', amount: 100 };
      
      const signature1 = signPayload(payload1, privKey1);
      const signature2 = signPayload(payload2, privKey2);
      
      const rawEvent1 = { payload: payload1, signature: signature1 };
      const rawEvent2 = { payload: payload2, signature: signature2 };

      const evidence: SignedEventEvidence[] = [
        {
          type: 'signed_event',
          raw_event: Buffer.from(JSON.stringify(rawEvent1)).toString('base64'),
          signature_scheme: 'ed25519',
          signer_pubkey: pubkeyHex1,
          claims: ['approver'],
          verification: 'required',
        },
        {
          type: 'signed_event',
          raw_event: Buffer.from(JSON.stringify(rawEvent2)).toString('base64'),
          signature_scheme: 'ed25519',
          signer_pubkey: pubkeyHex2,
          claims: ['executor'],
          verification: 'required',
        },
      ];

      const manifest: KeyManifest = {
        version: '1',
        keys: [
          {
            pubkey: pubkeyHex1,
            status: 'active',
            roles: ['approver'],
          },
          {
            pubkey: pubkeyHex2,
            status: 'active',
            roles: ['executor'],
          },
        ],
      };

      const results = verifySignedEvidence(evidence, manifest);
      
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('recomputed');
      expect(results[1].status).toBe('recomputed');
    });
  });
});