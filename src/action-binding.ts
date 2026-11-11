/**
 * Action-binding predicate for signed evidence.
 *
 * Opt-in by shape. Signature verification alone does not show that a signer
 * approved the action in this request. When the signed payload claims an
 * approval digest, this predicate recomputes sha256 of `proposed_action` and
 * requires exact equality with the digest inside the signed payload.
 *
 * Outer `signed_evidence[].claims` can force the check. They never supply
 * the digest. Requests that do not make an approval-digest claim skip this
 * predicate entirely.
 *
 * Not a BIP-340 verifier and not an Ed25519 re-signing bridge.
 */

import { createHash } from 'crypto';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - canonicalize types are loose; runtime export is the function
import canonicalize from 'canonicalize';

/** Explicit profile. Any other `binding_profile` value fails closed. */
export const ACTION_BINDING_PROFILE_V1 = 'thoughtproof.sentinel.action_binding.v1';

/**
 * Digest fields read from the signed payload only.
 * `approves_release_sha256` is the Buzz approval-content field.
 * `approves_sha256` is required when `binding_profile` is v1, and is also
 * recognized on its own.
 */
const SIGNED_DIGEST_FIELDS = ['approves_release_sha256', 'approves_sha256'] as const;

/**
 * Outer claim names that mean "this item approves a digest".
 * `approves_action_sha256` is recognized only as an outer claim. It is not
 * a signed digest field; the digest still has to be one of SIGNED_DIGEST_FIELDS.
 */
const OUTER_APPROVAL_CLAIM_NAMES = [
  'approves_release_sha256',
  'approves_sha256',
  'approves_action_sha256',
] as const;

const DIGEST_HEX = /^[0-9a-f]{64}$/;

export const ACTION_BINDING_FAILURE_CODES = [
  'action_binding_mismatch',
  'action_binding_missing_digest',
  'action_binding_digest_not_signed',
  'action_binding_unsupported_profile',
  'action_binding_malformed',
  'action_binding_missing_action',
] as const;

export type ActionBindingFailureCode = (typeof ACTION_BINDING_FAILURE_CODES)[number];

export interface ProposedActionSource {
  /** True when the request object has a `proposed_action` property. */
  present: boolean;
  value: unknown;
}

export type ActionBindingResult =
  | { ok: true; checked: boolean }
  | { ok: false; code: ActionBindingFailureCode; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Exact name, or that name plus a colon suffix. The suffix is never the digest. */
export function outerClaimNamesApprovalDigest(claim: string): boolean {
  for (const name of OUTER_APPROVAL_CLAIM_NAMES) {
    if (claim === name || claim.startsWith(`${name}:`)) return true;
  }
  return false;
}

function outerClaimsNameApproval(claims: readonly string[] | undefined): boolean {
  if (!claims) return false;
  for (const claim of claims) {
    if (typeof claim === 'string' && outerClaimNamesApprovalDigest(claim)) return true;
  }
  return false;
}

/**
 * Same shape rule as the binding predicate. Does not verify a signature.
 * A parsed payload counts even when its signature is invalid. Outer claims
 * count even when the payload cannot be parsed.
 */
export function isApprovalDigestClaim(
  payload: unknown,
  outerClaims: readonly string[] | undefined,
): boolean {
  const payloadObject = isPlainObject(payload) ? payload : null;
  const hasProfile = payloadObject !== null && hasOwn(payloadObject, 'binding_profile');
  const hasSignedDigestField =
    payloadObject !== null && SIGNED_DIGEST_FIELDS.some((key) => hasOwn(payloadObject, key));
  return hasProfile || hasSignedDigestField || outerClaimsNameApproval(outerClaims);
}

/**
 * Recognise an approval from outer claims and, when the bytes parse, from
 * the unverified payload. A corrupt signature does not hide the shape.
 */
export function rawEventClaimsApproval(
  rawEventBase64: unknown,
  outerClaims: readonly string[] | undefined,
): boolean {
  if (outerClaimsNameApproval(outerClaims)) return true;
  if (typeof rawEventBase64 !== 'string' || rawEventBase64.length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(rawEventBase64, 'base64').toString('utf8'));
    if (!isPlainObject(parsed)) return false;
    return isApprovalDigestClaim(parsed.payload, undefined);
  } catch {
    return false;
  }
}

/**
 * sha256 of the proposed action, lowercase hex.
 * - string: exact UTF-8 bytes, not re-canonicalized and not trimmed
 * - plain object or array: UTF-8 JCS
 * Returns null when the value cannot be hashed. Never throws.
 */
export function recomputeProposedActionDigest(action: unknown): string | null {
  try {
    let bytes: string;
    if (typeof action === 'string') {
      bytes = action;
    } else if (Array.isArray(action) || isPlainObject(action)) {
      const canonical = (canonicalize as unknown as (v: unknown) => string)(action);
      if (typeof canonical !== 'string') return null;
      bytes = canonical;
    } else {
      return null;
    }
    return createHash('sha256').update(bytes, 'utf8').digest('hex');
  } catch {
    return null;
  }
}

interface DigestField {
  key: string;
  present: boolean;
  hex?: string;
  malformed: boolean;
}

function readDigestField(payload: Record<string, unknown>, key: string): DigestField {
  if (!hasOwn(payload, key)) return { key, present: false, malformed: false };
  const value = payload[key];
  if (typeof value !== 'string' || !DIGEST_HEX.test(value)) {
    return { key, present: true, malformed: true };
  }
  return { key, present: true, hex: value, malformed: false };
}

function fail(code: ActionBindingFailureCode, reason: string): ActionBindingResult {
  return { ok: false, code, reason };
}

/**
 * Compare the signed approval digest to sha256(`proposed_action`).
 * `action_hash` is intentionally not an argument.
 */
export function checkActionBinding(
  payload: unknown,
  outerClaims: readonly string[] | undefined,
  proposedAction: ProposedActionSource | undefined,
): ActionBindingResult {
  if (!isApprovalDigestClaim(payload, outerClaims)) {
    return { ok: true, checked: false };
  }

  const payloadObject = isPlainObject(payload) ? payload : null;
  const hasProfile = payloadObject !== null && hasOwn(payloadObject, 'binding_profile');
  const signedFields = payloadObject
    ? SIGNED_DIGEST_FIELDS.map((key) => readDigestField(payloadObject, key))
    : [];

  // An approval-digest claim exists. Everything below fails closed.
  if (payloadObject === null) {
    return fail(
      'action_binding_malformed',
      'Approval digest claim is not inside a signed JSON object payload',
    );
  }

  if (hasProfile && payloadObject.binding_profile !== ACTION_BINDING_PROFILE_V1) {
    return fail(
      'action_binding_unsupported_profile',
      'Unsupported action-binding profile',
    );
  }

  const malformed = signedFields.find((field) => field.malformed);
  if (malformed) {
    return fail(
      'action_binding_malformed',
      `${malformed.key} must be 64 lowercase hex characters with no prefix`,
    );
  }

  if (hasProfile && !signedFields.some((field) => field.key === 'approves_sha256' && field.present)) {
    return fail(
      'action_binding_missing_digest',
      'Signed payload profile v1 is missing approves_sha256',
    );
  }

  const digests = signedFields.flatMap((field) => (field.hex ? [field.hex] : []));
  if (digests.length === 0) {
    return fail(
      'action_binding_digest_not_signed',
      'Approval digest was not present in the signed payload',
    );
  }
  if (new Set(digests).size !== 1) {
    return fail(
      'action_binding_malformed',
      'Signed payload contains disagreeing approval digests',
    );
  }

  const source = proposedAction ?? { present: false, value: undefined };
  if (!source.present) {
    return fail(
      'action_binding_missing_action',
      'Request has no proposed_action to recompute',
    );
  }

  const recomputed = recomputeProposedActionDigest(source.value);
  if (recomputed === null) {
    return fail(
      'action_binding_malformed',
      'proposed_action must be a string, array, or plain object',
    );
  }
  if (recomputed !== digests[0]) {
    return fail(
      'action_binding_mismatch',
      'Recomputed proposed action digest does not equal the signed approval digest',
    );
  }

  return { ok: true, checked: true };
}
