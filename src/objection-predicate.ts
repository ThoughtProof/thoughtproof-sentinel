/**
 * objection-predicate — the numeric-class objection binding (Federico design, 2026-07-07)
 *
 * THE FIX (in one sentence): our structural layer already produces a real
 * {kind, claimedValue, actualValue} triple, then FLATTENS it into a
 * "structural_fact:" prose line and asks the model to re-derive the comparison.
 * That round-trip (structured -> prose -> fuzzy re-judgment) is what made the
 * naive re-plan check degenerate to UNCERTAIN. This module stops the round-trip:
 * it carries the triple forward AS a checkable predicate, so the re-plan gate is
 * a deterministic boolean, not a judgment call.
 *
 * SCOPE (the honest boundary): this covers ONLY the three numeric objection
 * classes our structural checker emits as structured flags —
 *   - direction       (claimed up/down vs verified trend sign)
 *   - magnitude        (claimed %-move vs verified %-move)
 *   - range_position   (claimed "X% of range" vs verified range position)
 * The fuzzy classes (inferential integrity, self-contradiction, missing-evidence)
 * do NOT reduce to a field comparison and are explicitly left to fresh Sentinel
 * judgment. A verdict marks each objection as `predicate-gated` or
 * `fresh-judgment-only` so the enforcement level is visible per objection, never
 * one blanket level for the whole verdict.
 */

/** The three structurally-checkable objection classes. */
export type NumericObjectionKind = "direction" | "magnitude" | "range_position";

/** A falsifiable predicate authored at HOLD time, from the structural flag.
 *  `field` = what to read on the revised plan's verified value,
 *  `op`/`value` = the boolean condition the revision must satisfy to be
 *  considered responsive to THIS objection (independent of overall soundness). */
export interface ObjectionPredicate {
  kind: NumericObjectionKind;
  field: "trend_sign" | "move_pct" | "range_pct";
  op: ">=" | "<=" | "==" | "!=" | "approx";
  value: number;
  /** Tolerance for `approx` (percentage points), mirrors the checker's own. */
  tolerancePp?: number;
  /** Provenance: the original claimed vs verified values at hold time. */
  claimedValue: number;
  actualValue: number;
}

/** The structural flag shape our checkers emit (cb4a fact-check / VTA structural-check). */
export interface VerifiedFactFlag {
  kind: NumericObjectionKind;
  claimText?: string;
  claimedValue: number;
  actualValue: number;
  evidenceLine: string;
}

/**
 * Author a predicate from a hold-time structural flag. This is Federico's
 * "commit to a structured, checkable condition at the point of maximum context."
 *
 * The predicate says: to be RESPONSIVE to this objection, the revised plan's
 * corresponding verified value must line up with the ground truth the checker
 * measured — i.e. the revision must no longer claim something the data refutes.
 */
export function predicateFromFlag(flag: VerifiedFactFlag): ObjectionPredicate {
  switch (flag.kind) {
    case "direction":
      // The verified trend sign is authoritative. A responsive revision must
      // assert a direction matching the verified sign (+1 up / -1 down / 0 flat).
      return {
        kind: "direction",
        field: "trend_sign",
        op: "==",
        value: Math.sign(flag.actualValue),
        claimedValue: Math.sign(flag.claimedValue),
        actualValue: Math.sign(flag.actualValue),
      };
    case "magnitude":
      // Responsive revision: its claimed %-move must be within tolerance of the
      // verified move (no longer overstating the magnitude).
      return {
        kind: "magnitude",
        field: "move_pct",
        op: "approx",
        value: flag.actualValue,
        tolerancePp: 10.0, // MAGNITUDE_FLAG_MIN_PP
        claimedValue: flag.claimedValue,
        actualValue: flag.actualValue,
      };
    case "range_position":
      return {
        kind: "range_position",
        field: "range_pct",
        op: "approx",
        value: flag.actualValue,
        tolerancePp: 15.0, // RANGE_FLAG_MIN_PP
        claimedValue: flag.claimedValue,
        actualValue: flag.actualValue,
      };
  }
}

/**
 * The RE-PLAN GATE — a pure, deterministic boolean. No model, no judgment.
 * Given the predicate authored at hold time and the revised plan's verified
 * value for that field, does the revision satisfy the objection?
 *
 * This is the whole point: it cannot degenerate to UNCERTAIN because there is
 * no judgment call left — only a comparison on structured data. (NaN, Infinity,
 * undefined, null all fail closed to `false` — never a third state; see tests.)
 *
 * ⚠️ CRITICAL INVARIANT — `revisedValue` MUST be produced by the SAME
 * deterministic fact-checker that produced the hold-time `actualValue`
 * (structural-check.ts / fact-check.ts), measured from the revised plan against
 * ground-truth market data. It must NOT be a value the agent asserts about
 * itself. An agent-asserted `revisedValue` makes this gate meaningless: the
 * agent would simply claim whatever number passes. The gate's soundness rests
 * entirely on `revisedValue` being independently measured, not self-reported.
 */
export function satisfiesPredicate(
  predicate: ObjectionPredicate,
  revisedValue: number,
): boolean {
  switch (predicate.op) {
    case ">=":
      return revisedValue >= predicate.value;
    case "<=":
      return revisedValue <= predicate.value;
    case "==":
      return revisedValue === predicate.value;
    case "!=":
      return revisedValue !== predicate.value;
    case "approx":
      return Math.abs(revisedValue - predicate.value) <= (predicate.tolerancePp ?? 0);
    default:
      // Exhaustiveness guard — an unknown op must FAIL closed, never silently pass.
      return false;
  }
}

/** Enforcement level for a given objection, surfaced per-objection in the verdict. */
export type EnforcementLevel = "predicate-gated" | "fresh-judgment-only";

/** Classify an objection's enforcement level by whether it's a numeric class. */
export function enforcementLevel(kind: string): EnforcementLevel {
  return kind === "direction" || kind === "magnitude" || kind === "range_position"
    ? "predicate-gated"
    : "fresh-judgment-only";
}
