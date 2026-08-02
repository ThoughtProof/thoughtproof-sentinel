/**
 * Signed Evidence Verification (F1 action-bound verification)
 * ----------------------------------------------------------
 * 
 * Verifies cryptographic evidence items of type "signed_event" to enable
 * action-bound verification where verdicts are tied to exact package digests
 * and evidence is independently recomputable.
 * 
 * Evidence items with verification='required' force verdict changes:
 * - Invalid signature → BLOCK with evidence_signature_invalid:<index>
 * - Unauthorized signer → BLOCK with signer_not_authorized:<index>
 * - Manifest issues → UNCERTAIN with key_manifest_unverifiable:<index>
 * 
 * v0 supports ed25519 signatures only. Raw events must be JSON strings with
 * { payload, signature } where signature is ed25519 over JCS-canonicalized payload.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - canonicalize types are loose; runtime export is the function
import canonicalize from 'canonicalize';

/**
 * Evidence item type for cryptographically signed events.
 */
export interface SignedEventEvidence {
  type: 'signed_event';
  /** Base64-encoded exact bytes of the signed event */
  raw_event: string;
  /** Signature scheme - v0 supports ed25519 only */
  signature_scheme: 'ed25519';
  /** Hex-encoded signer public key */
  signer_pubkey: string;
  /** Optional reference to key manifest (v0: not network-fetched) */
  key_manifest_ref?: string;
  /** Claims made by this evidence item */
  claims: string[];
  /** Whether verification failure should force verdict change */
  verification: 'required' | 'optional';
}

/**
 * Key manifest for verifying signer authorization.
 * v0: inline object only, no network fetching.
 */
export interface KeyManifest {
  version: string;
  keys: KeyManifestEntry[];
}

export interface KeyManifestEntry {
  pubkey: string;
  status: 'active' | 'revoked' | 'rotated';
  not_before?: string;
  not_after?: string;
  roles?: string[];
}

/**
 * Raw signed event structure (v0 convention).
 * The signature is ed25519 over JCS-canonicalized payload.
 */
export interface RawSignedEvent {
  payload: unknown;
  signature: string;
}

/**
 * Result of verifying a single evidence item.
 */
export interface EvidenceVerificationResult {
  /** Verification status */
  status: 'recomputed' | 'supplied_only' | 'failed';
  /** Human-readable reason when failed */
  reason?: string;
  /** Verified signer public key when successful */
  signer?: string;
  /** Claims that were validated */
  claims_validated?: string[];
}

/**
 * Verify an array of signed evidence items against an optional key manifest.
 * 
 * @param evidence Array of signed evidence items to verify
 * @param keyManifest Optional key manifest for signer authorization
 * @returns Array of verification results, one per evidence item
 */
export function verifySignedEvidence(
  evidence: SignedEventEvidence[],
  keyManifest?: KeyManifest,
): EvidenceVerificationResult[] {
  return evidence.map((item, index) => {
    try {
      return verifySignedEvidenceItem(item, keyManifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown verification error';
      console.error(`[signed-evidence] verification failed for item ${index}:`, message);
      return {
        status: 'failed',
        reason: message,
      };
    }
  });
}

/**
 * Verify a single signed evidence item.
 */
function verifySignedEvidenceItem(
  item: SignedEventEvidence,
  keyManifest?: KeyManifest,
): EvidenceVerificationResult {
  // Only ed25519 is supported in v0
  if (item.signature_scheme !== 'ed25519') {
    return {
      status: 'failed',
      reason: `Unsupported signature scheme: ${item.signature_scheme}`,
    };
  }

  // Parse the raw event
  let rawEvent: RawSignedEvent;
  try {
    const eventBytes = Buffer.from(item.raw_event, 'base64');
    rawEvent = JSON.parse(eventBytes.toString('utf8'));
  } catch (error) {
    return {
      status: 'failed',
      reason: 'Invalid raw_event: not valid base64 JSON',
    };
  }

  if (!rawEvent.payload || typeof rawEvent.signature !== 'string') {
    return {
      status: 'failed',
      reason: 'Invalid raw_event structure: missing payload or signature',
    };
  }

  // Verify the signature over the canonicalized payload
  const canonicalPayload = canonicalizePayload(rawEvent.payload);
  const signatureValid = verifyEd25519Signature(
    canonicalPayload,
    rawEvent.signature,
    item.signer_pubkey,
  );

  if (!signatureValid) {
    return {
      status: 'failed',
      reason: 'Invalid signature over canonical payload',
    };
  }

  // Check signer authorization if manifest is provided
  if (keyManifest) {
    const authResult = checkSignerAuthorization(item.signer_pubkey, item.claims, keyManifest);
    if (!authResult.authorized) {
      return {
        status: 'failed',
        reason: authResult.reason,
      };
    }
  }

  // If manifest was referenced but not provided, this is a configuration issue
  if (item.key_manifest_ref && !keyManifest) {
    return {
      status: 'failed',
      reason: 'Key manifest referenced but not provided for verification',
    };
  }

  return {
    status: 'recomputed',
    signer: item.signer_pubkey,
    claims_validated: item.claims,
  };
}

/**
 * Canonicalize payload for signature verification (JCS per ed25519 convention).
 */
function canonicalizePayload(payload: unknown): Buffer {
  const canonicalJson = (canonicalize as unknown as (v: unknown) => string)(payload);
  if (typeof canonicalJson !== 'string') {
    throw new Error('canonicalize() did not return a string');
  }
  return Buffer.from(canonicalJson, 'utf8');
}

/**
 * Verify ed25519 signature using node:crypto.
 */
function verifyEd25519Signature(
  message: Buffer,
  signature: string,
  publicKeyHex: string,
): boolean {
  try {
    // Convert hex public key to PEM format for node:crypto
    const pubKeyBuffer = Buffer.from(publicKeyHex, 'hex');
    if (pubKeyBuffer.length !== 32) {
      throw new Error('Ed25519 public key must be 32 bytes');
    }

    // Create DER-encoded SubjectPublicKeyInfo for Ed25519
    // OID for Ed25519: 1.3.101.112 = 0x2b 0x65 0x70
    const derHeader = Buffer.from([
      0x30, 0x2a, // SEQUENCE (42 bytes total)
      0x30, 0x05, // SEQUENCE (5 bytes)
      0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112
      0x03, 0x21, 0x00, // BIT STRING (33 bytes, no unused bits)
    ]);
    const derEncoded = Buffer.concat([derHeader, pubKeyBuffer]);
    
    const pem = [
      '-----BEGIN PUBLIC KEY-----',
      derEncoded.toString('base64').match(/.{1,64}/g)?.join('\n') || derEncoded.toString('base64'),
      '-----END PUBLIC KEY-----',
    ].join('\n');

    const publicKey = createPublicKey(pem);
    const signatureBuffer = Buffer.from(signature.replace(/^0x/, ''), 'hex');
    
    return cryptoVerify(null, message, publicKey, signatureBuffer);
  } catch (error) {
    console.error('[signed-evidence] ed25519 verification error:', error);
    return false;
  }
}

/**
 * Check if a signer is authorized for the given claims per the key manifest.
 */
function checkSignerAuthorization(
  signerPubkey: string,
  claims: string[],
  manifest: KeyManifest,
): { authorized: boolean; reason?: string } {
  const key = manifest.keys.find((k) => k.pubkey.toLowerCase() === signerPubkey.toLowerCase());
  
  if (!key) {
    return {
      authorized: false,
      reason: 'Signer public key not found in manifest',
    };
  }

  if (key.status !== 'active') {
    return {
      authorized: false,
      reason: `Signer key status is ${key.status}, not active`,
    };
  }

  // Check time bounds if specified
  const now = new Date();
  if (key.not_before && now < new Date(key.not_before)) {
    return {
      authorized: false,
      reason: 'Signer key not yet valid (not_before)',
    };
  }

  if (key.not_after && now > new Date(key.not_after)) {
    return {
      authorized: false,
      reason: 'Signer key expired (not_after)',
    };
  }

  // Check role-based authorization if roles are specified
  if (key.roles && key.roles.length > 0) {
    const hasRequiredRole = claims.some(claim => {
      // Simple role matching - can be extended for more complex mappings
      return key.roles?.includes(claim) || key.roles?.includes('all');
    });

    if (!hasRequiredRole) {
      return {
        authorized: false,
        reason: `Signer key roles ${key.roles.join(',')} do not authorize claims ${claims.join(',')}`,
      };
    }
  }

  return { authorized: true };
}