/**
 * ADR-0023 stage-4 transport for `mandate_proof.signature`.
 * Not an ALLOW. The request-path module is the only caller, and only
 * when enforcement is on.
 *
 * The only accepted text is 128 lowercase hex characters:
 * `/^[0-9a-f]{128}$/`. A `0x` prefix, uppercase, whitespace, and any
 * other length are BLOCK. Domain separation
 * (`thoughtproof.sentinel.mandate.v1`, one 0x00, then JCS) protects the
 * signed content. The prefix is not part of that separation.
 *
 * Stage 3's verifier still strips an optional `0x` prefix. That parser
 * is not this transport check.
 */

import type { MandateNormalizeResult } from './mandate-normalize.js';

export const MANDATE_PROOF_SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;

export type MandateProofSignatureResult =
  | { ok: true; signature: string }
  | { ok: false; verdict: 'BLOCK'; reason: 'malformed_signature' };

/**
 * Accept the stage-4 signature text or BLOCK. Does not verify the
 * signature and does not return ALLOW.
 */
export function parseMandateProofSignature(value: unknown): MandateProofSignatureResult {
  if (typeof value !== 'string' || !MANDATE_PROOF_SIGNATURE_PATTERN.test(value)) {
    return { ok: false, verdict: 'BLOCK', reason: 'malformed_signature' };
  }
  return { ok: true, signature: value };
}

/**
 * Both the normalized mandate and the signature text have to be
 * acceptable before stage 4 can treat the transport as complete.
 * `true` is not a verdict and not an authorization. A failed
 * normalization never returns true.
 */
export function stage4TransportAccepts(
  normalization: MandateNormalizeResult,
  signature: MandateProofSignatureResult,
): boolean {
  return normalization.ok === true && signature.ok === true;
}
