export const ACTION_BINDING_PROFILE_V1: string;

export const ACTION_BINDING_FAILURE_CODES: readonly [
  'action_binding_mismatch',
  'action_binding_missing_digest',
  'action_binding_digest_not_signed',
  'action_binding_unsupported_profile',
  'action_binding_malformed',
  'action_binding_missing_action',
];

export type ActionBindingFailureCode = (typeof ACTION_BINDING_FAILURE_CODES)[number];

export interface ProposedActionSource {
  /** True when the request object has a `proposed_action` property. */
  present: boolean;
  value: unknown;
}

export type ActionBindingResult =
  | { ok: true; checked: boolean }
  | { ok: false; code: ActionBindingFailureCode; reason: string };

export function outerClaimNamesApprovalDigest(claim: string): boolean;

export function isApprovalDigestClaim(
  payload: unknown,
  outerClaims: readonly string[] | undefined,
): boolean;

export function rawEventClaimsApproval(
  rawEventBase64: unknown,
  outerClaims: readonly string[] | undefined,
): boolean;

export function recomputeProposedActionDigest(action: unknown): string | null;

export function checkActionBinding(
  payload: unknown,
  outerClaims: readonly string[] | undefined,
  proposedAction: ProposedActionSource | undefined,
): ActionBindingResult;
