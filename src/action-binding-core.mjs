/**
 * Action-binding predicate for signed evidence.
 *
 * Single implementation shared by the TypeScript server (via
 * src/action-binding.ts) and scripts/verify-receipt.mjs. Do not copy this
 * predicate into either caller.
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

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonText } from './json-duplicate-keys.mjs';

const require = createRequire(import.meta.url);

/** Explicit profile. Any other `binding_profile` value fails closed. */
export const ACTION_BINDING_PROFILE_V1 = 'thoughtproof.sentinel.action_binding.v1';

/**
 * Digest fields read from the signed payload only.
 * `approves_release_sha256` is the Buzz approval-content field.
 * `approves_sha256` is required when `binding_profile` is v1, and is also
 * recognized on its own.
 */
const SIGNED_DIGEST_FIELDS = ['approves_release_sha256', 'approves_sha256'];

/**
 * Outer claim names that mean "this item approves a digest".
 * `approves_action_sha256` is recognized only as an outer claim. It is not
 * a signed digest field; the digest still has to be one of SIGNED_DIGEST_FIELDS.
 */
const OUTER_APPROVAL_CLAIM_NAMES = [
  'approves_release_sha256',
  'approves_sha256',
  'approves_action_sha256',
];

const DIGEST_HEX = /^[0-9a-f]{64}$/;

export const ACTION_BINDING_FAILURE_CODES = Object.freeze([
  'action_binding_mismatch',
  'action_binding_missing_digest',
  'action_binding_digest_not_signed',
  'action_binding_unsupported_profile',
  'action_binding_malformed',
  'action_binding_missing_action',
]);

/** @type {((value: unknown) => string) | null} */
let canonicalizeFn = null;

function loadCanonicalize() {
  if (canonicalizeFn) return canonicalizeFn;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    () => require('canonicalize'),
    () => require(join(here, '..', 'node_modules', 'canonicalize')),
  ];
  for (const load of candidates) {
    try {
      const mod = load();
      const fn = typeof mod === 'function' ? mod : mod?.default;
      if (typeof fn === 'function') {
        canonicalizeFn = fn;
        return fn;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Exact name, or that name plus a colon suffix. The suffix is never the digest. */
export function outerClaimNamesApprovalDigest(claim) {
  for (const name of OUTER_APPROVAL_CLAIM_NAMES) {
    if (claim === name || claim.startsWith(`${name}:`)) return true;
  }
  return false;
}

function outerClaimsNameApproval(claims) {
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
export function isApprovalDigestClaim(payload, outerClaims) {
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
export function rawEventClaimsApproval(rawEventBase64, outerClaims) {
  try {
    return recogniseApproval(rawEventBase64, outerClaims);
  } catch {
    // A throw means the bytes were not examined. Do not report "not an approval".
    return true;
  }
}

function recogniseApproval(rawEventBase64, outerClaims) {
  if (outerClaimsNameApproval(outerClaims)) return true;
  if (typeof rawEventBase64 !== 'string' || rawEventBase64.length === 0) return false;
  let text;
  try {
    text = Buffer.from(rawEventBase64, 'base64').toString('utf8');
  } catch {
    return false;
  }
  const parsed = parseJsonText(text);
  if (!parsed.ok && parsed.code === 'json_unexamined') {
    const values = parsed.payloadValues;
    if (!values) return true;
    for (const payload of values) {
      if (isApprovalDigestClaim(payload, undefined)) return true;
    }
    return false;
  }
  if (!parsed.ok && parsed.code !== 'duplicate_json_key') return false;
  for (const payload of parsed.payloadValues) {
    if (isApprovalDigestClaim(payload, undefined)) return true;
  }
  if (!isPlainObject(parsed.value)) return false;
  return isApprovalDigestClaim(parsed.value.payload, undefined);
}

/**
 * sha256 of the proposed action, lowercase hex.
 * - string: exact UTF-8 bytes, not re-canonicalized and not trimmed
 * - plain object or array: UTF-8 JCS
 * Returns null when the value cannot be hashed. Never throws.
 */
export function recomputeProposedActionDigest(action) {
  try {
    let bytes;
    if (typeof action === 'string') {
      bytes = action;
    } else if (Array.isArray(action) || isPlainObject(action)) {
      const canonicalize = loadCanonicalize();
      if (!canonicalize) return null;
      const canonical = canonicalize(action);
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

function readDigestField(payload, key) {
  if (!hasOwn(payload, key)) return { key, present: false, malformed: false };
  const value = payload[key];
  if (typeof value !== 'string' || !DIGEST_HEX.test(value)) {
    return { key, present: true, malformed: true };
  }
  return { key, present: true, hex: value, malformed: false };
}

function fail(code, reason) {
  return { ok: false, code, reason };
}

/**
 * Compare the signed approval digest to sha256(`proposed_action`).
 * `action_hash` is intentionally not an argument.
 *
 * @returns {{ ok: true, checked: boolean } | { ok: false, code: string, reason: string }}
 */
export function checkActionBinding(payload, outerClaims, proposedAction) {
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
