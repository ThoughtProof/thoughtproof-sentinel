/**
 * ADR-0023 stage-4 prerequisite: how an existing API key becomes an
 * account id, and how rotation and a wrong account are classified.
 * Not called from the verify handler. Does not enable accounts.
 * Does not authorize execution.
 *
 * The account id is only the explicit field on the key record
 * (`key:platform:agent_id:account_id`). A pre-account record
 * (`key:platform:agent_id`) is HTTP 503. The agent id is not copied.
 * A request account id and X-Sentinel-Agent-Id are not read.
 *
 * Principal-key rotation is not this API-key field. A retired kid is
 * BLOCK for a new authorization. Historical verification is a separate
 * result and never authorizes execution.
 */

import {
  resolveServerAccountId,
  type ServerAccountLookup,
  type ServerAccountResult,
} from './server-account.js';

export type MigrationGateVerdict = 'ALLOW' | 'BLOCK' | 'UNCERTAIN';

export type PrincipalKeyStatus = 'active' | 'retired' | 'revoked';

/**
 * The stage-1 mapping. No other source is consulted.
 * A missing record and a record with no account field are both
 * `ACCOUNT_UNAVAILABLE`.
 */
export function migrateApiKeyToAccount(input: ServerAccountLookup): ServerAccountResult {
  return resolveServerAccountId(input);
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
