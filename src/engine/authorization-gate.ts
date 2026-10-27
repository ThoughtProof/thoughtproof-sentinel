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
 * REPORT (P3): `checked` and `skipped` name which of the three checks ran and
 * which were skipped because an input was missing or unparseable. They are
 * not inputs to wouldBlock, enforcedVerdict, promotion, or ALLOW. Canonical
 * v2 projects them; v1 does not.
 *
 * ROLLOUT (ADR-0019, shadow-mode-rollout skill): ships behind `gateMode`,
 * default `'shadow'` (computes + logs, does NOT gate). Only `'enforce'` lets a
 * gate BLOCK override the verdict. Tolerances are INITIAL / UNCALIBRATED until
 * measured on real mandate traffic.
 */

import type { SentinelVerdict } from '../types.js';
import type { ActionKind } from './action-auth-kind.js';

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
  /**
   * Caller-declared mandate kind (issue #51). BLOCK: present + valid
   * `ActionKind` always applies (declared `unknown` stays `unknown`).
   * ALLOW: unlocks only when prose does not contradict. Omitted →
   * prose fallback. `unknown` is fail-closed (no public ALLOW).
   */
  kind?: ActionKind;
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
    /**
     * Caller-declared action kind (issue #51). Sentinel contract for MCP
     * `action.kind`: map onto `mandate.action.kind`. Same asymmetric
     * rule as `mandate.kind` — BLOCK always applies; ALLOW needs prose
     * agreement. Omitted → prose; declared `unknown` stays `unknown`.
     */
    kind?: ActionKind;
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

export const GATE_VIOLATION_KINDS = [
  'amount_overshoot',
  'recipient_mismatch',
  'unlimited_approval',
] as const;

export type GateViolationKind = (typeof GATE_VIOLATION_KINDS)[number];

/**
 * Why a check did not run. Closed set. `gate_error` is only used when the
 * gate itself throws and returns silent; that result is not projected.
 */
export const GATE_SKIP_REASONS = [
  'missing_granted_amount',
  'missing_action_amount',
  'amount_not_finite',
  'missing_granted_recipient',
  'missing_action_recipient',
  'missing_allowance',
  'allowance_unparseable',
  'gate_error',
] as const;

export type GateSkipReason = (typeof GATE_SKIP_REASONS)[number];

export interface GateViolation {
  kind: GateViolationKind;
  detail: string;
}

/** One check that did not run. Report-only. */
export interface GateCheckSkip {
  kind: GateViolationKind;
  reason: GateSkipReason;
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
  /**
   * Checks whose inputs were present and were evaluated.
   * Report-only: never an input to wouldBlock or enforcedVerdict.
   */
  checked: GateViolationKind[];
  /**
   * Checks that did not run because an input was missing or unparseable.
   * Report-only: never an input to wouldBlock or enforcedVerdict.
   */
  skipped: GateCheckSkip[];
  /** True when the gate had no machine-readable mandate to act on (silent). */
  silent: boolean;
}

/**
 * The only verdict effect of the gate. Reads `enforcedVerdict` and nothing
 * from `checked` or `skipped`. Never returns ALLOW.
 */
export function gateEnforcedVerdict(
  result: Pick<AuthorizationGateResult, 'enforcedVerdict'> | null | undefined,
): 'BLOCK' | null {
  return result?.enforcedVerdict === 'BLOCK' ? 'BLOCK' : null;
}

/** Parse an allowance value into a finite number, or detect the unlimited
 * sentinels. Returns Infinity for unlimited, a finite number when parseable,
 * or null on ambiguity (→ silence). */
export function parseAllowance(allowance: string | number | undefined): number | null {
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

/** True when a structured allowance is unlimited / effectively unbounded. */
export function allowanceLooksUnlimited(
  allowance: string | number | undefined,
): boolean {
  const n = parseAllowance(allowance);
  return n !== null && n >= UNLIMITED_ALLOWANCE_THRESHOLD;
}

/** Normalize an identity (address/handle) for comparison. */
function normId(x: string | undefined): string | null {
  if (typeof x !== 'string') return null;
  const s = x.trim().toLowerCase();
  return s.length > 0 ? s : null;
}

function amountSkipReason(
  granted: AuthorizationMandate['granted'],
  action: AuthorizationMandate['action'],
): GateSkipReason {
  const grantedAmount = granted?.maxAmount;
  const actionAmount = action?.amount;
  if (typeof grantedAmount !== 'number') return 'missing_granted_amount';
  if (!Number.isFinite(grantedAmount)) return 'amount_not_finite';
  if (typeof actionAmount !== 'number') return 'missing_action_amount';
  return 'amount_not_finite';
}

function silentSkips(
  granted: AuthorizationMandate['granted'],
  action: AuthorizationMandate['action'],
): GateCheckSkip[] {
  const grantedRecipient = normId(granted?.recipient);
  const actionRecipient = normId(action?.recipient);
  const recipientReason: GateSkipReason =
    grantedRecipient === null
      ? 'missing_granted_recipient'
      : actionRecipient === null
        ? 'missing_action_recipient'
        : 'missing_granted_recipient';
  return [
    { kind: 'amount_overshoot', reason: amountSkipReason(granted, action) },
    { kind: 'recipient_mismatch', reason: recipientReason },
    { kind: 'unlimited_approval', reason: 'missing_allowance' },
  ];
}

function gateErrorSkips(): GateCheckSkip[] {
  return GATE_VIOLATION_KINDS.map((kind) => ({ kind, reason: 'gate_error' }));
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
  const checked: GateViolationKind[] = [];
  const skipped: GateCheckSkip[] = [];
  try {
    const granted = mandate?.granted;
    const action = mandate?.action;

    // No machine-readable financial fields → silent. Host-declared kinds
    // alone do not engage the numeric/identity gate (issue #51).
    const hasFinancialGranted = !!(
      granted &&
      (typeof granted.maxAmount === 'number' ||
        (typeof granted.recipient === 'string' && granted.recipient.trim() !== '') ||
        granted.allowUnlimited === true ||
        (typeof granted.asset === 'string' && granted.asset.trim() !== ''))
    );
    const hasFinancialAction = !!(
      action &&
      (typeof action.amount === 'number' ||
        (typeof action.recipient === 'string' && action.recipient.trim() !== '') ||
        (action.allowance !== undefined &&
          action.allowance !== null &&
          String(action.allowance).trim() !== '') ||
        (typeof action.asset === 'string' && action.asset.trim() !== ''))
    );
    if (!hasFinancialGranted && !hasFinancialAction) {
      return {
        mode,
        wouldBlock: false,
        enforcedVerdict: null,
        violations: [],
        silent: true,
        checked: [],
        skipped: silentSkips(granted, action),
      };
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
      checked.push('amount_overshoot');
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
    } else {
      skipped.push({ kind: 'amount_overshoot', reason: amountSkipReason(granted, action) });
    }

    // ── 2. Recipient mismatch (binary, unfixable) ──
    // Only when BOTH recipients are present. normalized inequality → BLOCK.
    if (granted && action) {
      const g = normId(granted.recipient);
      const a = normId(action.recipient);
      if (g !== null && a !== null) {
        checked.push('recipient_mismatch');
        if (g !== a) {
          violations.push({
            kind: 'recipient_mismatch',
            detail:
              `Action recipient "${action.recipient}" does not match the ` +
              `authorized recipient "${granted.recipient}". The principal did not ` +
              `authorize this counterparty.`,
          });
        }
      } else {
        skipped.push({
          kind: 'recipient_mismatch',
          reason: g === null ? 'missing_granted_recipient' : 'missing_action_recipient',
        });
      }
    } else {
      const g = normId(granted?.recipient);
      skipped.push({
        kind: 'recipient_mismatch',
        reason: g === null ? 'missing_granted_recipient' : 'missing_action_recipient',
      });
    }

    // ── 3. Unlimited approval not explicitly granted (binary, unfixable) ──
    if (action) {
      const rawAllowance = action.allowance;
      const allowanceMissing =
        rawAllowance === undefined ||
        rawAllowance === null ||
        (typeof rawAllowance === 'string' && rawAllowance.trim() === '');
      const allowance = parseAllowance(rawAllowance);
      if (allowanceMissing) {
        skipped.push({ kind: 'unlimited_approval', reason: 'missing_allowance' });
      } else if (allowance === null) {
        skipped.push({ kind: 'unlimited_approval', reason: 'allowance_unparseable' });
      } else {
        checked.push('unlimited_approval');
        const isUnlimited = allowance >= UNLIMITED_ALLOWANCE_THRESHOLD;
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
    } else {
      skipped.push({ kind: 'unlimited_approval', reason: 'missing_allowance' });
    }

    const wouldBlock = violations.length > 0;
    const enforcedVerdict: SentinelVerdict | null =
      mode === 'enforce' && wouldBlock ? 'BLOCK' : null;

    return { mode, wouldBlock, enforcedVerdict, violations, silent: false, checked, skipped };
  } catch {
    // Any parse/runtime issue → silence. Never block on a gate bug.
    // The report is not consulted; enforcedVerdict stays null.
    return {
      mode,
      wouldBlock: false,
      enforcedVerdict: null,
      violations: [],
      silent: true,
      checked: [],
      skipped: gateErrorSkips(),
    };
  }
}
