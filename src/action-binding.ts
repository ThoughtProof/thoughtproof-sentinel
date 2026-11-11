/**
 * Typed entry for the action-binding predicate.
 *
 * The body of the predicate is `action-binding-core.mjs`. The server and
 * `scripts/verify-receipt.mjs` both call that module, so there is one
 * implementation. This file only re-exports it for TypeScript callers.
 */

export {
  ACTION_BINDING_PROFILE_V1,
  ACTION_BINDING_FAILURE_CODES,
  outerClaimNamesApprovalDigest,
  isApprovalDigestClaim,
  rawEventClaimsApproval,
  recomputeProposedActionDigest,
  checkActionBinding,
} from './action-binding-core.mjs';

export type {
  ActionBindingFailureCode,
  ProposedActionSource,
  ActionBindingResult,
} from './action-binding-core.mjs';
