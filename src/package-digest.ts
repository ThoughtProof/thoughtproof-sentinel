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

import { createHash } from 'crypto';
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