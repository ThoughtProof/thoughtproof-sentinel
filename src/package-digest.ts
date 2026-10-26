/**
 * Package Digest Computation (F1 action-bound verification)
 * ----------------------------------------------------------
 * 
 * Computes SHA256 hash of JCS-canonicalized validated requests to enable
 * action-bound verification where verdicts are tied to exact package contents.
 * 
 * The package digest binds the verdict to the exact request that was verified,
 * making the verification result recomputable by third parties.
 */

import { createHash, randomBytes } from 'crypto';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - canonicalize types are loose; runtime export is the function
import canonicalize from 'canonicalize';
import type { SentinelVerifyRequest } from './types.js';

/**
 * Compute package digest from a validated request.
 * 
 * @param request The validated request (after successful validateVerifyRequest)
 * @returns SHA256 hash as hex string with "sha256:" prefix
 */
export function computePackageDigest(request: SentinelVerifyRequest): string {
  // Create a clean version of the request for canonicalization
  // Remove any undefined fields to ensure deterministic serialization
  const cleanRequest = removeUndefinedFields(request);
  
  // JCS canonicalization (same as used in canonical verdict)
  const canonical = (canonicalize as unknown as (v: unknown) => string)(cleanRequest);
  if (typeof canonical !== 'string') {
    throw new Error('canonicalize() did not return a string');
  }
  
  // Compute SHA256 hash
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * Recursively remove undefined fields for deterministic serialization.
 */
function removeUndefinedFields(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(removeUndefinedFields);
  }
  
  if (typeof obj === 'object') {
    const cleaned: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        cleaned[key] = removeUndefinedFields(value);
      }
    }
    
    return cleaned;
  }
  
  return obj;
}

/** 32-byte salt for mandate/action commitments. Not a secret key; it is caller-private. */
export const COMMITMENT_SALT_BYTES = 32;

const COMMITMENT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMITMENT_SALT_HEX = /^[0-9a-f]{64}$/;

/**
 * sha256(salt || UTF-8(JCS(value))), as `sha256:` + lowercase hex.
 * JCS matches computePackageDigest: drop undefined fields, then canonicalize.
 * An unsalted hash of a mandate is dictionary-reversible (amount, recipient, kind).
 * The salt is not part of the hashed value and must stay off the public receipt.
 */
export function saltedCommitmentDigest(value: unknown, salt: Buffer): string {
  if (!Buffer.isBuffer(salt) || salt.length !== COMMITMENT_SALT_BYTES) {
    throw new Error('commitment salt must be 32 bytes');
  }
  const canonical = (canonicalize as unknown as (v: unknown) => string)(
    removeUndefinedFields(value),
  );
  if (typeof canonical !== 'string') {
    throw new Error('canonicalize() did not return a string');
  }
  const hex = createHash('sha256').update(salt).update(canonical, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

export interface MandateActionCommitments {
  /** Lowercase hex of the 32-byte salt. Returned to the caller, not signed. */
  digestSalt: string;
  mandateDigest?: string;
  actionDigest?: string;
}

function commitmentAction(mandate: unknown): unknown {
  if (mandate === null || typeof mandate !== 'object' || Array.isArray(mandate)) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(mandate, 'action')) return undefined;
  const action = (mandate as { action?: unknown }).action;
  if (action === undefined || action === null) return undefined;
  return action;
}

function tryCommitment(value: unknown, salt: Buffer): string | undefined {
  try {
    const digest = saltedCommitmentDigest(value, salt);
    return COMMITMENT_DIGEST.test(digest) ? digest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Salted commitments for a validated mandate and, when present, its action.
 * Returns undefined when both are absent or neither digest can be produced.
 * Does not throw. A hash failure omits that field only.
 * Pass `salt` in tests; production generates 32 crypto-random bytes per call.
 */
export function computeMandateActionCommitments(
  mandate: unknown,
  salt?: Buffer,
): MandateActionCommitments | undefined {
  if (mandate === undefined || mandate === null) return undefined;
  let saltBytes: Buffer;
  try {
    saltBytes = salt ?? randomBytes(COMMITMENT_SALT_BYTES);
  } catch {
    return undefined;
  }
  if (!Buffer.isBuffer(saltBytes) || saltBytes.length !== COMMITMENT_SALT_BYTES) {
    return undefined;
  }

  const result: MandateActionCommitments = { digestSalt: saltBytes.toString('hex') };
  const mandateDigest = tryCommitment(mandate, saltBytes);
  if (mandateDigest) result.mandateDigest = mandateDigest;
  const action = commitmentAction(mandate);
  if (action !== undefined) {
    const actionDigest = tryCommitment(action, saltBytes);
    if (actionDigest) result.actionDigest = actionDigest;
  }
  if (!result.mandateDigest && !result.actionDigest) return undefined;
  return result;
}

export interface V2CommitmentSupplements {
  mandateDigest?: string;
  actionDigest?: string;
  digestSaltCandidate?: string;
}

/** Fail-safe wrapper for the verify handler. Never throws. */
export function prepareV2CommitmentSupplements(mandate: unknown): V2CommitmentSupplements {
  try {
    const commitments = computeMandateActionCommitments(mandate);
    if (!commitments) return {};
    return {
      mandateDigest: commitments.mandateDigest,
      actionDigest: commitments.actionDigest,
      digestSaltCandidate: commitments.digestSalt,
    };
  } catch {
    return {};
  }
}

/**
 * Return the caller salt only when the issued v2 canonical actually carries
 * at least one commitment. Otherwise omit it. Never throws.
 */
export function digestSaltIfCommitted(
  canonicalJcs: string | undefined,
  digestSalt: string | undefined,
): string | undefined {
  if (!digestSalt || !COMMITMENT_SALT_HEX.test(digestSalt)) return undefined;
  if (typeof canonicalJcs !== 'string' || canonicalJcs.length === 0) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(canonicalJcs);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const mandateOk =
    typeof record.mandateDigest === 'string' && COMMITMENT_DIGEST.test(record.mandateDigest);
  const actionOk =
    typeof record.actionDigest === 'string' && COMMITMENT_DIGEST.test(record.actionDigest);
  if (!mandateOk && !actionOk) return undefined;
  return digestSalt;
}

export function responseDigestSalt(
  signedExportV2: { canonical?: string } | null | undefined,
  digestSaltCandidate: string | undefined,
): string | undefined {
  try {
    return digestSaltIfCommitted(signedExportV2?.canonical, digestSaltCandidate);
  } catch {
    return undefined;
  }
}

/**
 * Verify a package digest against a request.
 *
 * @param request The request to check
 * @param expectedDigest The expected digest (with "sha256:" prefix)
 * @returns true if the digest matches
 */
export function verifyPackageDigest(
  request: SentinelVerifyRequest,
  expectedDigest: string,
): boolean {
  if (!expectedDigest.startsWith('sha256:')) {
    return false;
  }
  
  try {
    const computedDigest = computePackageDigest(request);
    return computedDigest === expectedDigest;
  } catch (error) {
    console.error('[package-digest] verification failed:', error);
    return false;
  }
}