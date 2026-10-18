import {createHash} from 'node:crypto';

/** Caller-supplied order facts; never extracted or repaired by a model. */
export interface TradeRiskInput {
  policy: 'cycle-risk-v1';
  side: 'long' | 'short';
  entry: number;
  stop: number;
  /** Actual order notional / account equity (not margin / equity). */
  size_pct: number;
  risk_pct: number;
  leverage: number;
  macro_size_mult: number;
}

export interface TradeRiskResult {
  schema_version: 'sentinel.trade-risk-result.v1';
  status: 'pass' | 'block' | 'invalid';
  checked_input: TradeRiskInput | null;
  evidence_sha256: string;
  actual_risk_pct: number | null;
  allowed_risk_pct: number | null;
  codes: string[];
}

// This named profile mirrors Cycle Engine's unchanged hard limits. The caller
// cannot raise these limits through evidence, gateMode, a model or extra fields.
export const CYCLE_RISK_LIMITS = Object.freeze({max_risk_pct: 0.01, max_leverage: 2});
const numericFields = ['entry', 'stop', 'size_pct', 'risk_pct', 'leverage', 'macro_size_mult'] as const;
const fields = new Set(['policy', 'side', ...numericFields]);

export function tradeRiskInputErrors(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['object_required'];
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (Object.keys(r).some(k => !fields.has(k))) errors.push('unknown_field');
  if (r.policy !== 'cycle-risk-v1') errors.push('unsupported_policy');
  if (r.side !== 'long' && r.side !== 'short') errors.push('invalid_side');
  for (const field of numericFields) {
    if (typeof r[field] !== 'number' || !Number.isFinite(r[field])) errors.push(`invalid_${field}`);
  }
  return errors;
}

/** No I/O or model call. A pass is necessary for this profile, never permission. */
export function runTradeRiskGate(raw: unknown, evidence: string): TradeRiskResult {
  const errors = tradeRiskInputErrors(raw);
  const base = {
    schema_version: 'sentinel.trade-risk-result.v1' as const,
    evidence_sha256: createHash('sha256').update(evidence).digest('hex'),
  };
  if (errors.length) return {...base, status: 'invalid', checked_input: null,
    actual_risk_pct: null, allowed_risk_pct: null, codes: errors};
  const r = {...raw as TradeRiskInput};
  const codes: string[] = [];
  // Cycle sends the same snapshot in its structured contract and JSON evidence.
  // If a trade_plan is present, contradictory duplicates cannot be waved through
  // by a model. Free-form legacy evidence has no machine-readable order binding.
  let document: unknown;
  try { document = JSON.parse(evidence); } catch { /* Semantic evidence need not be JSON. */ }
  if (document && typeof document === 'object' && 'trade_plan' in document) {
    const p = (document as {trade_plan: any}).trade_plan;
    if (!p || typeof p !== 'object' || p.side !== r.side || p.entry !== r.entry || p.stop !== r.stop
        || p.size_pct !== r.size_pct || p.risk_pct !== r.risk_pct || p.leverage !== r.leverage
        || p.macro?.size_mult !== r.macro_size_mult) codes.push('evidence_order_mismatch');
  }
  if (r.entry <= 0 || r.stop <= 0) codes.push('invalid_price');
  if (r.risk_pct <= 0 || r.risk_pct > CYCLE_RISK_LIMITS.max_risk_pct) codes.push('risk_limit');
  if (r.leverage < 1 || r.leverage > CYCLE_RISK_LIMITS.max_leverage) codes.push('leverage_limit');
  if (r.size_pct <= 0 || r.size_pct > r.leverage) codes.push('order_notional_limit');
  if (r.macro_size_mult < 0 || r.macro_size_mult > 1) codes.push('invalid_macro_multiplier');
  if (r.macro_size_mult === 0) codes.push('macro_halt');
  if ((r.side === 'long' && r.stop >= r.entry) || (r.side === 'short' && r.stop <= r.entry)) codes.push('stop_direction');
  const actual = r.size_pct * (Math.abs(r.entry - r.stop) / r.entry);
  const allowed = Math.min(r.risk_pct, CYCLE_RISK_LIMITS.max_risk_pct) * r.macro_size_mult;
  if (!Number.isFinite(actual) || !Number.isFinite(allowed) || actual <= 0) codes.push('invalid_calculation');
  // Same dimensionless floating-point tolerance as the local Cycle gate.
  if (actual > allowed + 1e-10) codes.push('stop_risk_exceeds_budget');
  return {...base, status: codes.length ? 'block' : 'pass', checked_input: r,
    actual_risk_pct: Number.isFinite(actual) ? actual : null,
    allowed_risk_pct: Number.isFinite(allowed) ? allowed : null, codes};
}
