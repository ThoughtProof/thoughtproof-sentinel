/**
 * ADR-0023 stage-4 prerequisite: how an existing API key becomes an
 * account id, and how rotation and a wrong account are classified.
 * Not called from the verify handler. Does not enable accounts.
 * Does not authorize execution.
 *
 * The account id is only the explicit field on the key record
 * (`key:platform:agent_id:account_id`). HTTP 503 is only for an
 * already-authenticated key whose record has no account id.
 * An invalid or removed key stays the auth layer's 401.
 * The agent id is not copied. A request account id and
 * X-Sentinel-Agent-Id are not read.
 *
 * Principal-key rotation is not this API-key field. A retired kid is
 * BLOCK for a new authorization. Historical verification is a separate
 * result and never authorizes execution.
 */

import { parseSentinelApiKeyRecords } from './server-account.js';

export type MigrationGateVerdict = 'ALLOW' | 'BLOCK' | 'UNCERTAIN';

export type PrincipalKeyStatus = 'active' | 'retired' | 'revoked';

/**
 * A principal `validateApiKey` has already accepted or rejected.
 * This function does not replace that decision with HTTP 503.
 */
export interface PrincipalAuthState {
  authenticated: boolean;
  apiKey: string;
}

export interface AuthenticatedAccountMappingInput {
  principal: PrincipalAuthState;
  /** Server env fixture. Required for a mapping. A missing fixture is unreadable. */
  env?: Record<string, unknown>;
  /** Ignored. It must not select the account. */
  requestAccountId?: string;
  /** Ignored. It must not select the account. */
  agentIdHeader?: string;
}

export type AuthenticatedAccountMapping =
  | { ok: true; accountId: string }
  | { ok: false; httpStatus: 503; code: 'ACCOUNT_UNAVAILABLE' }
  | { applies: false; authorizesExecution: false };

/**
 * Map an already-authenticated key to its server account id.
 * HTTP 503 `ACCOUNT_UNAVAILABLE` only when `principal.authenticated`
 * is true, the key is present in the server record, and that record
 * has no account id (migration required). An unauthenticated principal,
 * an invalid key, or a key that is no longer in the list does not get
 * that 503. Those stay the auth layer's 401. Request fields are ignored.
 */
export function mapAuthenticatedPrincipalToAccount(
  input: AuthenticatedAccountMappingInput,
): AuthenticatedAccountMapping {
  void input.requestAccountId;
  void input.agentIdHeader;

  if (input.principal.authenticated !== true || input.principal.apiKey.length === 0) {
    return { applies: false, authorizesExecution: false };
  }

  let raw: unknown;
  try {
    if (!input.env) return { ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' };
    raw = input.env.SENTINEL_API_KEYS;
  } catch {
    return { ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' };
  }

  const records = parseSentinelApiKeyRecords(raw);
  if (!records) return { ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' };

  const matched = records.find((record) => record.key === input.principal.apiKey);
  if (!matched) return { applies: false, authorizesExecution: false };
  if (!matched.accountId || matched.accountId.trim().length === 0) {
    return { ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' };
  }
  return { ok: true, accountId: matched.accountId };
}

export interface HistoricalVerificationInput {
  /**
   * Observation from a signature check the caller already performed.
   * True does not authorize execution.
   */
  signatureMatched: boolean;
  keyStatus: PrincipalKeyStatus;
}

export interface HistoricalVerificationResult {
  purpose: 'historical';
  authorizesExecution: false;
  signatureMatched: boolean;
  keyStatus: PrincipalKeyStatus;
  ok: false;
  verdict: 'BLOCK';
  reason: 'historical_not_authorization';
}

/**
 * Historical check of a principal signature. Separate from a new
 * authorization. `signatureMatched: true` stays BLOCK and
 * `authorizesExecution` stays false, including for a key that was
 * active in an old window. This is not `mandate_source: principal_signed`.
 */
export function historicalPrincipalVerification(
  input: HistoricalVerificationInput,
): HistoricalVerificationResult {
  return {
    purpose: 'historical',
    authorizesExecution: false,
    signatureMatched: input.signatureMatched,
    keyStatus: input.keyStatus,
    ok: false,
    verdict: 'BLOCK',
    reason: 'historical_not_authorization',
  };
}

/**
 * A historical result is not an execution verdict.
 * BLOCK stays BLOCK. UNCERTAIN stays UNCERTAIN.
 * A gate ALLOW does not survive: this path does not authorize execution.
 * The signature observation is not read.
 */
export function verdictFromHistoricalVerification(
  historical: HistoricalVerificationResult,
  gateVerdict: MigrationGateVerdict,
): 'BLOCK' | 'UNCERTAIN' {
  void historical.signatureMatched;
  void historical.keyStatus;
  if (gateVerdict === 'UNCERTAIN') return 'UNCERTAIN';
  return 'BLOCK';
}

export type WrongAccountClass =
  | {
      source: 'manifest';
      ok: false;
      httpStatus: 503;
      code: 'MANIFEST_MALFORMED';
    }
  | {
      source: 'proof';
      ok: false;
      verdict: 'BLOCK';
      reason: 'account_mismatch';
    };

/**
 * Manifest `accountId` mismatch is an invalid document: HTTP 503.
 * Proof `account_id` mismatch is a known-invalid proof: BLOCK.
 * Neither selects the other account. Neither is ALLOW.
 */
export function classifyWrongAccount(source: 'manifest' | 'proof'): WrongAccountClass {
  if (source === 'manifest') {
    return { source: 'manifest', ok: false, httpStatus: 503, code: 'MANIFEST_MALFORMED' };
  }
  return { source: 'proof', ok: false, verdict: 'BLOCK', reason: 'account_mismatch' };
}
