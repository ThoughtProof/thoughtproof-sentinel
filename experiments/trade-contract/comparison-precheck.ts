/**
 * Deterministic pre-check mirrored from the authorization gate.
 * Same three binary violations and the same constants as
 * src/engine/authorization-gate.ts (UNLIMITED_ALLOWANCE_THRESHOLD at the
 * 1e30 declaration, AMOUNT_OVERSHOOT_TOLERANCE 0.005, runAuthorizationGate
 * amount / recipient / unlimited branches). A case passes when none of
 * those three violations fire. Skipped checks are not a pass: every
 * comparison case supplies all three inputs.
 *
 * This module does not import src/, so the isolated experiment typecheck
 * stays outside the repository diagnostic set.
 */

const UNLIMITED_ALLOWANCE_THRESHOLD = 1e30;
const AMOUNT_OVERSHOOT_TOLERANCE = 0.005;

export interface PrecheckInput {
  maxAmount: number;
  grantedRecipient: string;
  actionAmount: number;
  actionRecipient: string;
  allowance: string;
}

export function deterministicPrecheckPasses(input: PrecheckInput): boolean {
  if (!Number.isFinite(input.maxAmount) || !Number.isFinite(input.actionAmount)) return false;
  const ceiling = input.maxAmount * (1 + AMOUNT_OVERSHOOT_TOLERANCE);
  if (input.actionAmount > ceiling) return false;
  const granted = input.grantedRecipient.trim().toLowerCase();
  const action = input.actionRecipient.trim().toLowerCase();
  if (granted.length === 0 || action.length === 0 || granted !== action) return false;
  if (!/^\d+(\.\d+)?$/.test(input.allowance.trim())) return false;
  const allowance = Number(input.allowance);
  if (!Number.isFinite(allowance) || allowance >= UNLIMITED_ALLOWANCE_THRESHOLD) return false;
  return true;
}
