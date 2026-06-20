/**
 * Deterministic Authorization Gate (ADR-0019 follow-up)
 *
 * The action_authorization LLM cascade is robust on the CATEGORICAL drain
 * vectors (unlimited approval, wrong recipient, unknown bridge) but
 * non-deterministic on ARITHMETIC (instructed 200 vs proposed 2,000 — the model
 * sometimes skips the comparison). This is the same class cb4a-verify solved for
 * trading: a quantitative scope check belongs in a deterministic layer, not the
 * LLM. See cb4a-verify/src/fact-check.ts for the sister pattern.
 *
 * This gate runs BEFORE the LLM. It only acts on a machine-readable `mandate`
 * the caller supplies (granted scope + proposed action). It checks three
 * BINARY, UNFIXABLE authority violations and hard-BLOCKs them:
 *
 *   1. Amount overshoot   — action.amount > granted.maxAmount
 *   2. Recipient mismatch  — action.recipient != granted.recipient
 *   3. Unlimited approval  — action.allowance is unlimited and the principal
 *                            did not explicitly grant unlimited
 *
 * PHILOSOPHY — fail toward silence (same iron rule as cb4a fact-check):
 * The gate speaks ONLY when it can extract the relevant fields with full
 * confidence AND they violate the mandate beyond a generous tolerance. On ANY
 * missing field, parse ambiguity, or internal error → it stays SILENT and lets
 * the LLM cascade decide. The deterministic layer can only ADD blocks on
 * unambiguous numeric/identity violations; it never allows anything the LLM
 * would have blocked. So its risk surface is false-BLOCK (a legit action gated),
 * never false-ALLOW — and shadow-mode calibration measures exactly that before
 * it is allowed to gate.
 *
 * ROLLOUT (ADR-0019, shadow-mode-rollout skill): ships behind `gateMode`,
 * default `'shadow'` (computes + logs, does NOT gate). Only `'enforce'` lets a
 * gate BLOCK override the verdict. Tolerances are INITIAL / UNCALIBRATED until
 * measured on real mandate traffic.
 */

import type { SentinelVerdict } from '../types.js';

/** Effectively-unlimited allowance threshold. MAX_UINT256 ≈ 1.16e77; any
 * allowance at or above this magnitude is an unlimited-approval in practice.
 * Kept well below MAX_UINT256 so near-max values (common obfuscation) also trip.
 * INITIAL / UNCALIBRATED. */
const UNLIMITED_ALLOWANCE_THRESHOLD = 1e30;

/** Amount-overshoot tolerance: the action amount may exceed the granted amount
 * by at most this fraction before it is a hard overshoot. Small, to absorb
 * float/rounding artifacts (e.g. fee-inclusive figures) without letting a real
 * 10x overshoot (200 → 2,000) through. INITIAL / UNCALIBRATED. */
const AMOUNT_OVERSHOOT_TOLERANCE = 0.005; // 0.5%

export type GateMode = 'shadow' | 'enforce';

/** Machine-readable mandate the caller MAY supply on action_authorization
 * requests. All fields optional — the gate checks only the pairs it can read
 * with confidence and stays silent otherwise. */
export interface AuthorizationMandate {
  /** What the principal authorized. */
  granted?: {
    /** Maximum amount the principal authorized (in the asset's units). */
    maxAmount?: number;
    /** Asset symbol or address the principal authorized. */
    asset?: string;
    /** The counterparty / spender / recipient the principal authorized. */
    recipient?: string;
    /** Did the principal EXPLICITLY grant an unlimited approval? Default false. */
    allowUnlimited?: boolean;
  };
  /** What the agent proposes to do. */
  action?: {
    /** Amount the action moves/spends (in the asset's units). */
    amount?: number;
    /** Asset symbol or address the action touches. */
    asset?: string;
    /** Recipient / spender / counterparty of the action. */
    recipient?: string;
    /** Approval allowance. Accepts a number, or a string such as
     * "MAX_UINT256" / "unlimited" / a decimal/hex numeric string. */
    allowance?: string | number;
  };
}

export type GateViolationKind =
  | 'amount_overshoot'
  | 'recipient_mismatch'
  | 'unlimited_approval';

export interface GateViolation {
  kind: GateViolationKind;
  detail: string;
}

export interface AuthorizationGateResult {
  /** The mode the gate ran in. */
  mode: GateMode;
  /** Whether the gate WOULD block (true) regardless of mode. */
  wouldBlock: boolean;
  /** The verdict the gate enforces: 'BLOCK' only in enforce mode with a
   * violation; null when the gate does not override (shadow, or no violation). */
  enforcedVerdict: SentinelVerdict | null;
  /** All hard violations detected (binary, unfixable). */
  violations: GateViolation[];
  /** True when the gate had no machine-readable mandate to act on (silent). */
  silent: boolean;
}

/** Parse an allowance value into a finite number, or detect the unlimited
 * sentinels. Returns Infinity for unlimited, a finite number when parseable,
 * or null on ambiguity (→ silence). */
function parseAllowance(allowance: string | number | undefined): number | null {
  if (allowance === undefined || allowance === null) return null;
  if (typeof allowance === 'number') {
    return Number.isFinite(allowance) ? allowance : null;
  }
  const s = allowance.trim().toLowerCase();
  if (s.length === 0) return null;
  if (s === 'unlimited' || s === 'max_uint256' || s === 'maxuint256' || s === 'infinite' || s === 'max') {
    return Infinity;
  }
  // Hex (e.g. 0xfff...f) — common for MAX_UINT256.
  if (/^0x[0-9a-f]+$/.test(s)) {
    // A 64-hex-digit (256-bit) value at/near max is unlimited. Compare length
    // and leading nibbles rather than risk BigInt precision games.
    const hex = s.slice(2);
    if (hex.length >= 64 && /^f+$/.test(hex.slice(0, 8))) return Infinity;
    const n = Number(s);
    return Number.isFinite(n) ? n : Infinity; // overflow → treat as unlimited
  }
  // Plain decimal numeric string.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  return null; // unparseable → silence
}

/** Normalize an identity (address/handle) for comparison. */
function normId(x: string | undefined): string | null {
  if (typeof x !== 'string') return null;
  const s = x.trim().toLowerCase();
  return s.length > 0 ? s : null;
}

/**
 * Run the deterministic authorization gate. Pure function: mandate + mode in,
 * structured result out. NEVER throws — on any internal issue it returns a
 * silent result, preserving fail-toward-silence (the LLM cascade is the
 * backstop).
 */
export function runAuthorizationGate(
  mandate: AuthorizationMandate | undefined,
  mode: GateMode,
): AuthorizationGateResult {
  const violations: GateViolation[] = [];
  try {
    const granted = mandate?.granted;
    const action = mandate?.action;

    // No machine-readable mandate → silent. LLM path handles everything.
    if (!granted && !action) {
      return { mode, wouldBlock: false, enforcedVerdict: null, violations: [], silent: true };
    }

    // ── 1. Amount overshoot (binary, unfixable) ──
    // Only when BOTH amounts are finite numbers. action > granted*(1+tol) → BLOCK.
    if (
      granted &&
      action &&
      typeof granted.maxAmount === 'number' &&
      Number.isFinite(granted.maxAmount) &&
      typeof action.amount === 'number' &&
      Number.isFinite(action.amount)
    ) {
      const ceiling = granted.maxAmount * (1 + AMOUNT_OVERSHOOT_TOLERANCE);
      if (action.amount > ceiling) {
        violations.push({
          kind: 'amount_overshoot',
          detail:
            `Action amount ${action.amount} exceeds the granted maximum ` +
            `${granted.maxAmount}` +
            (granted.asset || action.asset ? ` (${action.asset ?? granted.asset})` : '') +
            `. The principal did not authorize this magnitude.`,
        });
      }
    }

    // ── 2. Recipient mismatch (binary, unfixable) ──
    // Only when BOTH recipients are present. normalized inequality → BLOCK.
    if (granted && action) {
      const g = normId(granted.recipient);
      const a = normId(action.recipient);
      if (g !== null && a !== null && g !== a) {
        violations.push({
          kind: 'recipient_mismatch',
          detail:
            `Action recipient "${action.recipient}" does not match the ` +
            `authorized recipient "${granted.recipient}". The principal did not ` +
            `authorize this counterparty.`,
        });
      }
    }

    // ── 3. Unlimited approval not explicitly granted (binary, unfixable) ──
    if (action) {
      const allowance = parseAllowance(action.allowance);
      const isUnlimited = allowance !== null && allowance >= UNLIMITED_ALLOWANCE_THRESHOLD;
      const grantedUnlimited = granted?.allowUnlimited === true;
      if (isUnlimited && !grantedUnlimited) {
        violations.push({
          kind: 'unlimited_approval',
          detail:
            `Action sets an unlimited / effectively-unbounded approval ` +
            `(${String(action.allowance)}) but the principal did not grant ` +
            `unlimited approval. Least-privilege requires an exact-amount allowance.`,
        });
      }
    }

    const wouldBlock = violations.length > 0;
    const enforcedVerdict: SentinelVerdict | null =
      mode === 'enforce' && wouldBlock ? 'BLOCK' : null;

    return { mode, wouldBlock, enforcedVerdict, violations, silent: false };
  } catch {
    // Any parse/runtime issue → silence. Never block on a gate bug.
    return { mode, wouldBlock: false, enforcedVerdict: null, violations: [], silent: true };
  }
}
