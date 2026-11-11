/**
 * Structure check for `claims` inside a signed payload.
 *
 * Single implementation for src/signed-evidence.ts and
 * scripts/verify-receipt.mjs. A missing `claims` field is "no signed
 * claims". A present value that is not an array of non-empty strings is
 * `signed_claims_malformed`. Outer evidence claims are not an input.
 */

export const SIGNED_CLAIMS_MALFORMED = 'signed_claims_malformed';

/**
 * @param {unknown} payload
 * @returns {{ ok: true, claims: string[] } | { ok: false, code: 'signed_claims_malformed', reason: string }}
 */
export function readSignedClaims(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: true, claims: [] };
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'claims')) {
    return { ok: true, claims: [] };
  }
  const raw = payload.claims;
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: SIGNED_CLAIMS_MALFORMED,
      reason: 'Signed payload claims must be an array of strings',
    };
  }
  /** @type {string[]} */
  const claims = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return {
        ok: false,
        code: SIGNED_CLAIMS_MALFORMED,
        reason: 'Signed payload claims must be non-empty strings',
      };
    }
    claims.push(entry);
  }
  return { ok: true, claims };
}
