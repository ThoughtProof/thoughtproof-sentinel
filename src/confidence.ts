/**
 * Receipt confidence helpers (issue #39).
 *
 * Policy: coerce missing / NaN / Infinity step scores to 0 (fail-closed).
 * A degraded cascade must produce a readable low score, never NaN —
 * `JSON.stringify(NaN)` becomes `null` on signed receipts.
 */

/** Missing, NaN, Infinity, or non-number → 0. Finite numbers pass through. */
export function finiteScore(score: unknown): number {
  return typeof score === 'number' && Number.isFinite(score) ? score : 0;
}

/**
 * Guarantee a unit-interval confidence: finite number in [0, 1].
 * Out-of-range values clamp; non-finite values fail closed to 0.
 */
export function clampUnitConfidence(score: unknown): number {
  const n = finiteScore(score);
  const clamped = Math.max(0, Math.min(1, n));
  return Number.isFinite(clamped) ? clamped : 0;
}

/**
 * Engine / HTTP receipt confidence: [0, 1], 3 decimal places, always finite.
 */
export function receiptConfidence(score: unknown): number {
  const rounded = Math.round(clampUnitConfidence(score) * 1000) / 1000;
  return Number.isFinite(rounded) ? rounded : 0;
}

/**
 * Canonical / EAS form: integer 0–100. Copies through {@link clampUnitConfidence}
 * so NaN cannot become NaN on-chain or in JCS.
 */
export function confidenceToPercent(unit: unknown): number {
  const pct = Math.round(clampUnitConfidence(unit) * 100);
  return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
}
