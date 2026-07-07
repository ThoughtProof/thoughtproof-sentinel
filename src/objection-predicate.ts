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

// ───────────────────────────────────────────────────────────────────────────
// VERIFIED-REVISION MEASUREMENT — enforce the load-bearing "given an
// independently-measured revision value" condition, instead of documenting it.
//
// The steelman's decisive point: satisfiesPredicate() is only sound if
// `revisedValue` is MEASURED from ground truth, not asserted by the agent. This
// section makes that structural: the caller cannot hand the gate a raw number;
// it must hand a MeasuredValue that carries proof of where the number came from.
// ───────────────────────────────────────────────────────────────────────────

/** The verified market facts the checker measures against — the SAME snapshot
 *  the agent reasoned over, but read by us, not parsed from the agent's text.
 *  Mirrors the fields verified-trading-agent/src/structural-check.ts reads. */
export interface VerifiedMarketFacts {
  priceChangePct24h: number;
  change7dPct: number;
  price: number;
  low24h: number;
  high24h: number;
}

/** A revision value that is PROVABLY measured, not agent-asserted. The `source`
 *  is a required discriminant — the gate below only accepts this wrapper, so a
 *  bare number (which could be agent-reported) is a type error at the boundary. */
export interface MeasuredValue {
  value: number;
  /** Must be "fact-checker" — the field exists to make agent-asserted values
   *  impossible to pass without lying in the type, which is auditable. */
  source: "fact-checker";
  field: ObjectionPredicate["field"];
}

/**
 * Measure the revised plan's value for a predicate's field DIRECTLY from the
 * verified market snapshot — never from the agent's revised text. This is the
 * function that earns the word "measured": it computes the same ground-truth
 * quantity the hold's actualValue came from, for the revised decision's context.
 */
export function measureRevisedValue(
  predicate: ObjectionPredicate,
  facts: VerifiedMarketFacts,
): MeasuredValue {
  switch (predicate.field) {
    case "trend_sign":
      return { value: Math.sign(facts.change7dPct), source: "fact-checker", field: "trend_sign" };
    case "move_pct": {
      // The verified move is the market fact nearest the predicate value —
      // mirrors structural-check.ts's nearest-of(24h, 7d) selection.
      const candidates = [Math.abs(facts.priceChangePct24h), Math.abs(facts.change7dPct)];
      const nearest = candidates.reduce((best, v) =>
        Math.abs(v - predicate.value) < Math.abs(best - predicate.value) ? v : best,
      );
      return { value: nearest, source: "fact-checker", field: "move_pct" };
    }
    case "range_pct": {
      const pos = facts.high24h > facts.low24h
        ? ((facts.price - facts.low24h) / (facts.high24h - facts.low24h)) * 100
        : NaN; // degenerate range → NaN → gate fails closed
      return { value: pos, source: "fact-checker", field: "range_pct" };
    }
  }
}

/**
 * The SOUND re-plan gate. Unlike satisfiesPredicate (which trusts its caller to
 * pass a measured number), this accepts only a MeasuredValue and verifies its
 * provenance + field alignment before delegating to the boolean check. This is
 * the "given" clause enforced end-to-end: an agent-asserted number cannot reach
 * the boolean without failing the type/provenance guard first.
 */
export function checkRevision(
  predicate: ObjectionPredicate,
  measured: MeasuredValue,
): { satisfied: boolean; reason: string } {
  if (measured.source !== "fact-checker")
    return { satisfied: false, reason: "revision value is not fact-checker-measured (fail-closed)" };
  if (measured.field !== predicate.field)
    return { satisfied: false, reason: `field mismatch: predicate=${predicate.field} value=${measured.field}` };
  const satisfied = satisfiesPredicate(predicate, measured.value);
  return {
    satisfied,
    reason: `measured ${measured.field}=${measured.value} vs {op:${predicate.op}, value:${predicate.value}${predicate.tolerancePp !== undefined ? `, tol:${predicate.tolerancePp}` : ""}} => ${satisfied}`,
  };
}
