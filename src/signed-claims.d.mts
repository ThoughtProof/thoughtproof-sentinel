export const SIGNED_CLAIMS_MALFORMED: 'signed_claims_malformed';

export type SignedClaimsResult =
  | { ok: true; claims: string[] }
  | { ok: false; code: 'signed_claims_malformed'; reason: string };

export function readSignedClaims(payload: unknown): SignedClaimsResult;
