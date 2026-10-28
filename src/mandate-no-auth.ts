/**
 * ADR-0023 stage-4 prerequisite: no authenticated account.
 * Not called from the verify handler.
 *
 * When `SENTINEL_AUTH_REQUIRED` is not exactly `true`, `validateApiKey`
 * returns `{ valid: true }` and no account id. A key record with no
 * account field also leaves the account id unset. This module does not
 * invent one, and it does not turn that gap into ALLOW or into
 * `caller_declared`.
 *
 * 503 is unverifiable (no account, bad manifest, store down).
 * BLOCK is known-invalid (empty mandate, bad proof, retired key).
 * A verified signature does not move either one to ALLOW.
 */

export type Stage4FailureKind =
  | 'no_account'
  | 'manifest_wrong_account'
  | 'manifest_unavailable'
  | 'replay_store_unavailable'
  | 'empty_mandate'
  | 'missing_action'
  | 'proof_wrong_account'
  | 'retired_key'
  | 'historical';

export type Stage4FailureClass =
  | { class: 'unverifiable'; httpStatus: 503; code: string }
  | { class: 'known_invalid'; verdict: 'BLOCK'; reason: string };

/**
 * The stage-4 failure table. Every row is 503 or BLOCK.
 * There is no ALLOW row.
 */
export function stage4FailureClass(kind: Stage4FailureKind): Stage4FailureClass {
  switch (kind) {
    case 'no_account':
      return { class: 'unverifiable', httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' };
    case 'manifest_wrong_account':
      return { class: 'unverifiable', httpStatus: 503, code: 'MANIFEST_MALFORMED' };
    case 'manifest_unavailable':
      return { class: 'unverifiable', httpStatus: 503, code: 'MANIFEST_UNAVAILABLE' };
    case 'replay_store_unavailable':
      return { class: 'unverifiable', httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' };
    case 'empty_mandate':
      return { class: 'known_invalid', verdict: 'BLOCK', reason: 'empty' };
    case 'missing_action':
      return { class: 'known_invalid', verdict: 'BLOCK', reason: 'action_missing' };
    case 'proof_wrong_account':
      return { class: 'known_invalid', verdict: 'BLOCK', reason: 'account_mismatch' };
    case 'retired_key':
      return { class: 'known_invalid', verdict: 'BLOCK', reason: 'retired' };
    case 'historical':
      return {
        class: 'known_invalid',
        verdict: 'BLOCK',
        reason: 'historical_not_authorization',
      };
  }
}

export interface NoAuthMandateInput {
  /** Absent or blank when auth is off or the key record has no account field. */
  authenticatedAccountId: string | undefined;
  /** Ignored. A present proof does not change the no-account result. */
  mandateProofPresent: boolean;
  /** Ignored. A verified signature does not change the no-account result. */
  signatureVerified: boolean;
  /** Ignored. A concrete action does not change the no-account result. */
  concreteAction: boolean;
}

export type NoAuthMandateDecision =
  | {
      applies: true;
      ok: false;
      httpStatus: 503;
      code: 'ACCOUNT_UNAVAILABLE';
    }
  | {
      /**
       * An account id was supplied. This function is not the decider and
       * not an authorization. The caller still has to run normalization
       * and the principal check.
       */
      applies: false;
      authorizesExecution: false;
    };

function hasAccountId(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export const MANDATE_VERIFICATION_UNAVAILABLE_MESSAGE = 'Mandate verification unavailable';

export const STAGE4_UNAVAILABLE_CODES = [
  'ACCOUNT_UNAVAILABLE',
  'MANIFEST_UNAVAILABLE',
  'MANIFEST_MALFORMED',
  'TARGET_ENVIRONMENT_UNAVAILABLE',
  'RECEIPT_TIME_UNUSABLE',
  'REPLAY_STORE_UNAVAILABLE',
] as const;

export type Stage4UnavailableCode = (typeof STAGE4_UNAVAILABLE_CODES)[number];

export interface Stage4UnavailableBody {
  error: typeof MANDATE_VERIFICATION_UNAVAILABLE_MESSAGE;
  code: Stage4UnavailableCode;
  request_id: string;
}

function isUnavailableCode(value: string): value is Stage4UnavailableCode {
  return (STAGE4_UNAVAILABLE_CODES as readonly string[]).includes(value);
}

/**
 * Stage-4 HTTP 503 body. Three fields, no `verdict`. The message is
 * constant. `cause` and `mandate` are ignored so an exception or the
 * mandate plaintext cannot leak into the body. Not wired to a handler.
 * BLOCK stays a separate result and is not passed through here.
 */
export function stage4UnavailablePayload(input: {
  code: string;
  requestId: string;
  cause?: unknown;
  mandate?: unknown;
}): Stage4UnavailableBody {
  void input.cause;
  void input.mandate;
  const code = isUnavailableCode(input.code) ? input.code : 'ACCOUNT_UNAVAILABLE';
  return {
    error: MANDATE_VERIFICATION_UNAVAILABLE_MESSAGE,
    code,
    request_id: typeof input.requestId === 'string' ? input.requestId : '',
  };
}

/**
 * Mandate path when the caller might have no account.
 * No account → HTTP 503 `ACCOUNT_UNAVAILABLE`, not BLOCK and not ALLOW.
 * An account id → this decider does not apply and does not authorize.
 */
export function decideNoAuthMandatePath(input: NoAuthMandateInput): NoAuthMandateDecision {
  void input.mandateProofPresent;
  void input.signatureVerified;
  void input.concreteAction;
  if (hasAccountId(input.authenticatedAccountId)) {
    return { applies: false, authorizesExecution: false };
  }
  return {
    applies: true,
    ok: false,
    httpStatus: 503,
    code: 'ACCOUNT_UNAVAILABLE',
  };
}
