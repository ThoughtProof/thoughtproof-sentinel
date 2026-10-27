/**
 * Pure time checks for a principal mandate proof (ADR-0023).
 * Not wired into the request path. Not an input to ALLOW.
 * A failed check is BLOCK. Success means the window is still open,
 * which is not a verdict.
 */

/** Product decision, not a tunable default. */
export const MANDATE_PROOF_SKEW_SECONDS = 30;

/** Product decision: validity is at most 5 minutes. */
export const MANDATE_PROOF_MAX_WINDOW_SECONDS = 300;

export interface MandateProofTimes {
  iat: number;
  exp: number;
}

export type MandateProofTimeFailure =
  | 'non_positive_window'
  | 'not_yet_valid'
  | 'window_too_long'
  | 'expired';

export type MandateProofTimeResult =
  | { ok: true }
  | { ok: false; verdict: 'BLOCK'; reason: MandateProofTimeFailure };

function isFiniteNumber(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function reject(reason: MandateProofTimeFailure): MandateProofTimeResult {
  return { ok: false, verdict: 'BLOCK', reason };
}

/**
 * Receipt-time checks. `exp > iat` is required. `iat == exp` is rejected.
 * Does not return ALLOW.
 */
export function checkMandateProofTimes(
  times: MandateProofTimes,
  now: number,
): MandateProofTimeResult {
  if (!isFiniteNumber(times.iat) || !isFiniteNumber(times.exp) || !isFiniteNumber(now)) {
    return reject('non_positive_window');
  }
  if (!(times.exp > times.iat)) {
    return reject('non_positive_window');
  }
  if (times.exp - times.iat > MANDATE_PROOF_MAX_WINDOW_SECONDS) {
    return reject('window_too_long');
  }
  if (times.iat > now + MANDATE_PROOF_SKEW_SECONDS) {
    return reject('not_yet_valid');
  }
  if (!(times.exp > now - MANDATE_PROOF_SKEW_SECONDS)) {
    return reject('expired');
  }
  return { ok: true };
}

/**
 * Expiry re-check at the atomic nonce-consumption step.
 * Uses server time and the 30-second skew. An expired proof is BLOCK, never ALLOW.
 */
export function recheckExpiryBeforeNonceConsumption(
  times: MandateProofTimes,
  nowAtConsumption: number,
): MandateProofTimeResult {
  if (!isFiniteNumber(times.iat) || !isFiniteNumber(times.exp) || !isFiniteNumber(nowAtConsumption)) {
    return reject('expired');
  }
  if (!(times.exp > times.iat)) {
    return reject('non_positive_window');
  }
  if (!(times.exp > nowAtConsumption - MANDATE_PROOF_SKEW_SECONDS)) {
    return reject('expired');
  }
  return { ok: true };
}

/**
 * Validate at one clock reading, then re-check expiry at a later reading
 * before the nonce would be consumed. The second reading is the fake or
 * real server clock at consumption time.
 */
export function checkWindowThenConsume(
  times: MandateProofTimes,
  nowAtValidation: number,
  nowAtConsumption: number,
): MandateProofTimeResult {
  const validated = checkMandateProofTimes(times, nowAtValidation);
  if (!validated.ok) return validated;
  return recheckExpiryBeforeNonceConsumption(times, nowAtConsumption);
}
