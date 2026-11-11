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
 * An item recognised as an approval (outer claims and/or the parsed payload,
 * signature not required) fails closed with BLOCK on the whole path —
 * signature, binding, and manifest authority — even when verification is
 * 'optional'. The digest is read from the signed payload and compared to
 * sha256(proposed_action).
 *
 * claims_validated is taken from payload.claims. Outer item.claims are not
 * reported as validated. Manifest role matching still uses item.claims.
 *
 * v0 supports ed25519 signatures only. Raw events must be JSON strings with
 * { payload, signature } where signature is ed25519 over JCS-canonicalized payload.
 * BIP-340 is unsupported_signature_scheme. There is no re-signing bridge.
 */

import { createPublicKey, verify as cryptoVerify } from 'crypto';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - canonicalize types are loose; runtime export is the function
import canonicalize from 'canonicalize';
import {
  checkActionBinding,
  rawEventClaimsApproval,
  type ProposedActionSource,
} from './action-binding.js';
import { parseJsonText } from './json-duplicate-keys.mjs';
import { readSignedClaims } from './signed-claims.mjs';

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
  /**
   * Failure severity (structured — do NOT string-match on `reason`).
   * - 'block': evidence is invalid or signer is not authorized
   *   (invalid signature, malformed/tampered raw_event, revoked/expired/
   *    not-yet-valid key, role mismatch, unsupported scheme)
   * - 'uncertain': the verifier cannot determine validity
   *   (manifest referenced but not provided, key not in manifest)
   */
  severity?: 'block' | 'uncertain';
  /** Stable machine-readable failure code (e.g. evidence_signature_invalid). */
  code?: string;
  /** Human-readable reason when failed (truncated to 500 chars) */
  reason?: string;
  /** Verified signer public key when successful */
  signer?: string;
  /**
   * Claims read from the signed payload. Empty when the payload has no
   * `claims` array. Never copied from the outer evidence item.
   * Omitted on failure — a failed item has not validated any claims.
   */
  claims_validated?: string[];
  /**
   * Structured flag. Set on every failure of an item recognised as an
   * approval, so processSignedEvidence forces BLOCK even when the caller
   * marked the item optional. Recognition does not require a valid signature.
   */
  forcesBlock?: boolean;
}

/** Truncate attacker-influenced text before it enters API responses. */
function truncateReason(text: string, max = 500): string {
  return text.length > max ? text.slice(0, max) + '…[truncated]' : text;
}

/** Structured failure helper — severity and code travel with the result. */
function failure(
  severity: 'block' | 'uncertain',
  code: string,
  reason: string,
): EvidenceVerificationResult {
  return { status: 'failed', severity, code, reason: truncateReason(reason) };
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
  proposedAction: ProposedActionSource = { present: false, value: undefined },
): EvidenceVerificationResult[] {
  return evidence.map((item, index) => {
    const approval = rawEventClaimsApproval(item?.raw_event, item?.claims);
    try {
      return verifySignedEvidenceItem(item, keyManifest, proposedAction, approval);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown verification error';
      console.error(`[signed-evidence] verification failed for item ${index}:`, message);
      // Non-approval internal errors stay UNCERTAIN. A recognised approval
      // cannot be left as an optional ALLOW.
      return withApprovalForce(
        failure('uncertain', 'evidence_verification_error', message),
        approval,
      );
    }
  });
}

function withApprovalForce(
  result: EvidenceVerificationResult,
  approval: boolean,
): EvidenceVerificationResult {
  if (!approval || result.status !== 'failed') return result;
  return { ...result, forcesBlock: true };
}

/**
 * Verify a single signed evidence item.
 */
function verifySignedEvidenceItem(
  item: SignedEventEvidence,
  keyManifest: KeyManifest | undefined,
  proposedAction: ProposedActionSource,
  approval: boolean,
): EvidenceVerificationResult {
  const fail = (result: EvidenceVerificationResult) => withApprovalForce(result, approval);

  // Only ed25519 is supported in v0
  if (item.signature_scheme !== 'ed25519') {
    return fail(failure('block', 'unsupported_signature_scheme',
      `Unsupported signature scheme: ${item.signature_scheme}`));
  }

  // Parse the raw event. Duplicate keys are rejected before the signature
  // so two parsers cannot disagree about which value was signed.
  let rawEvent: RawSignedEvent;
  try {
    const eventBytes = Buffer.from(item.raw_event, 'base64');
    const parsed = parseJsonText(eventBytes.toString('utf8'));
    if (!parsed.ok && parsed.code === 'duplicate_json_key') {
      return fail(failure('block', 'duplicate_json_key',
        'Signed JSON contains a duplicate key'));
    }
    if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') {
      return fail(failure('block', 'evidence_malformed',
        'Invalid raw_event: not valid base64 JSON'));
    }
    rawEvent = parsed.value as RawSignedEvent;
  } catch (error) {
    return fail(failure('block', 'evidence_malformed',
      'Invalid raw_event: not valid base64 JSON'));
  }

  if (!rawEvent.payload || typeof rawEvent.signature !== 'string') {
    return fail(failure('block', 'evidence_malformed',
      'Invalid raw_event structure: missing payload or signature'));
  }

  // Verify the signature over the canonicalized payload
  const canonicalPayload = canonicalizePayload(rawEvent.payload);
  const signatureValid = verifyEd25519Signature(
    canonicalPayload,
    rawEvent.signature,
    item.signer_pubkey,
  );

  if (!signatureValid) {
    return fail(failure('block', 'evidence_signature_invalid',
      'Invalid signature over canonical payload'));
  }

  // Binding uses the authenticated payload only.
  let binding: ReturnType<typeof checkActionBinding>;
  try {
    binding = checkActionBinding(rawEvent.payload, item.claims, proposedAction);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Action-binding check failed';
    return fail(failure('block', 'action_binding_malformed', message));
  }
  if (!binding.ok) {
    return fail(failure('block', binding.code, binding.reason));
  }

  const signedClaims = readSignedClaims(rawEvent.payload);
  if (!signedClaims.ok) {
    return fail(failure('block', signedClaims.code, signedClaims.reason));
  }

  // Check signer authorization if manifest is provided
  if (keyManifest) {
    const authResult = checkSignerAuthorization(item.signer_pubkey, item.claims, keyManifest);
    if (!authResult.authorized) {
      return fail(failure(authResult.severity, authResult.code, authResult.reason ?? 'Signer not authorized'));
    }
  }

  // If manifest was referenced but not provided, the verifier cannot
  // determine whether the signer is authorized. For an approval this still
  // forces BLOCK; otherwise it stays UNCERTAIN.
  if (item.key_manifest_ref && !keyManifest) {
    return fail(failure('uncertain', 'key_manifest_unverifiable',
      'Key manifest referenced but not provided for verification'));
  }

  return {
    status: 'recomputed',
    signer: item.signer_pubkey,
    claims_validated: signedClaims.claims,
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
 *
 * Authorization failures classify as:
 * - 'block' (signer_not_authorized): key known but revoked/expired/not-yet-valid/role-mismatch
 * - 'uncertain' (key_manifest_unverifiable): key not present in the manifest at all
 */
function checkSignerAuthorization(
  signerPubkey: string,
  claims: string[],
  manifest: KeyManifest,
): { authorized: boolean; severity: 'block' | 'uncertain'; code: string; reason?: string } {
  const key = manifest.keys.find((k) => k.pubkey.toLowerCase() === signerPubkey.toLowerCase());

  const deny = (severity: 'block' | 'uncertain', code: string, reason: string) =>
    ({ authorized: false, severity, code, reason });

  if (!key) {
    return deny('uncertain', 'key_manifest_unverifiable',
      'Signer public key not found in manifest');
  }

  if (key.status !== 'active') {
    return deny('block', 'signer_not_authorized',
      `Signer key status is ${key.status}, not active`);
  }

  // Check time bounds if specified
  const now = new Date();
  if (key.not_before && now < new Date(key.not_before)) {
    return deny('block', 'signer_not_authorized',
      'Signer key not yet valid (not_before)');
  }

  if (key.not_after && now > new Date(key.not_after)) {
    return deny('block', 'signer_not_authorized',
      'Signer key expired (not_after)');
  }

  // Check role-based authorization if roles are specified
  if (key.roles && key.roles.length > 0) {
    const hasRequiredRole = claims.some(claim => {
      // Simple role matching - can be extended for more complex mappings
      return key.roles?.includes(claim) || key.roles?.includes('all');
    });

    if (!hasRequiredRole) {
      return deny('block', 'signer_not_authorized',
        `Signer key roles ${key.roles.join(',')} do not authorize claims ${claims.join(',')}`);
    }
  }

  return { authorized: true, severity: 'block', code: '' };
}