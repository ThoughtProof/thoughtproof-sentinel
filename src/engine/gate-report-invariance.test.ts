/**
 * Gate report is verdict-invariant.
 *
 * `checked` and `skipped` are a report. This file pins the pre-report
 * decision (wouldBlock, enforcedVerdict, silent, violation kinds) and the
 * promotion that sits beside it. Across the mandate × mode matrix the live
 * gate matches that decision, and swapping the report does not change the
 * verdict or the promotion. UNCERTAIN and evaluator-error promotions stay
 * off ALLOW. HTTP 401, 429, and 5xx are refusals with no verdict.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rateLimitUnavailablePayload } from '../auth.js';
import { modelConfigUnavailablePayload } from '../model-config.js';
import {
  GATE_SKIP_REASONS,
  GATE_VIOLATION_KINDS,
  gateEnforcedVerdict,
  runAuthorizationGate,
  type AuthorizationGateResult,
  type AuthorizationMandate,
  type GateMode,
  type GateViolationKind,
} from './authorization-gate.js';
import { mapVerdict, resolveActionAuthPromotion, type ActionAuthPromotionDecision } from './verdict.js';
// @ts-expect-error The portable verifier is plain JavaScript.
import { GATE_REPORT_KINDS, GATE_REPORT_SKIP_REASONS } from '../../scripts/verify-canonical-export.mjs';

const LEGACY_UNLIMITED = 1e30;
const LEGACY_TOLERANCE = 0.005;

interface LegacyDecision {
  wouldBlock: boolean;
  enforcedVerdict: 'BLOCK' | null;
  silent: boolean;
  kinds: GateViolationKind[];
}

function legacyParseAllowance(allowance: string | number | undefined): number | null {
  if (allowance === undefined || allowance === null) return null;
  if (typeof allowance === 'number') return Number.isFinite(allowance) ? allowance : null;
  const s = allowance.trim().toLowerCase();
  if (s.length === 0) return null;
  if (s === 'unlimited' || s === 'max_uint256' || s === 'maxuint256' || s === 'infinite' || s === 'max') {
    return Infinity;
  }
  if (/^0x[0-9a-f]+$/.test(s)) {
    const hex = s.slice(2);
    if (hex.length >= 64 && /^f+$/.test(hex.slice(0, 8))) return Infinity;
    const n = Number(s);
    return Number.isFinite(n) ? n : Infinity;
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function legacyNormId(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  return s.length > 0 ? s : null;
}

/** Pre-P3 control flow. Report arrays are not inputs. */
function legacyDecision(
  mandate: AuthorizationMandate | undefined,
  mode: GateMode,
): LegacyDecision {
  const violations: GateViolationKind[] = [];
  try {
    const granted = mandate?.granted;
    const action = mandate?.action;
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
      return { wouldBlock: false, enforcedVerdict: null, silent: true, kinds: [] };
    }
    if (
      granted &&
      action &&
      typeof granted.maxAmount === 'number' &&
      Number.isFinite(granted.maxAmount) &&
      typeof action.amount === 'number' &&
      Number.isFinite(action.amount)
    ) {
      const ceiling = granted.maxAmount * (1 + LEGACY_TOLERANCE);
      if (action.amount > ceiling) violations.push('amount_overshoot');
    }
    if (granted && action) {
      const grantedRecipient = legacyNormId(granted.recipient);
      const actionRecipient = legacyNormId(action.recipient);
      if (grantedRecipient !== null && actionRecipient !== null && grantedRecipient !== actionRecipient) {
        violations.push('recipient_mismatch');
      }
    }
    if (action) {
      const allowance = legacyParseAllowance(action.allowance);
      const isUnlimited = allowance !== null && allowance >= LEGACY_UNLIMITED;
      if (isUnlimited && granted?.allowUnlimited !== true) violations.push('unlimited_approval');
    }
    const wouldBlock = violations.length > 0;
    return {
      wouldBlock,
      enforcedVerdict: mode === 'enforce' && wouldBlock ? 'BLOCK' : null,
      silent: false,
      kinds: violations,
    };
  } catch {
    return { wouldBlock: false, enforcedVerdict: null, silent: true, kinds: [] };
  }
}

function decisionOf(result: AuthorizationGateResult): LegacyDecision {
  return {
    wouldBlock: result.wouldBlock,
    enforcedVerdict: result.enforcedVerdict === 'BLOCK' ? 'BLOCK' : null,
    silent: result.silent,
    kinds: result.violations.map((violation) => violation.kind),
  };
}

interface GateRow {
  mandate: AuthorizationMandate | undefined;
  mode: GateMode;
}

function gateMatrix(): GateRow[] {
  const rows: GateRow[] = [
    { mandate: undefined, mode: 'shadow' },
    { mandate: undefined, mode: 'enforce' },
    { mandate: {}, mode: 'enforce' },
    { mandate: { kind: 'value_transfer', action: { kind: 'informational' } }, mode: 'enforce' },
  ];
  const grantedAmounts = [undefined, 200, Number.NaN, Number.POSITIVE_INFINITY];
  const actionAmounts = [undefined, 200, 200.5, 202, 2000];
  const grantedRecipients = [undefined, '', '0xACME', '0xAcme'];
  const actionRecipients = [undefined, '0xACME', '0xBAD'];
  const allowances: Array<string | number | undefined> = [
    undefined, '', 'lots', 200, 'MAX_UINT256', '0x' + 'f'.repeat(64), 1e40,
  ];
  const allowUnlimited = [undefined, false, true];
  for (const maxAmount of grantedAmounts) {
    for (const amount of actionAmounts) {
      for (const grantedRecipient of grantedRecipients) {
        for (const actionRecipient of actionRecipients) {
          for (const allowance of allowances) {
            for (const flag of allowUnlimited) {
              const mandate: AuthorizationMandate = {
                granted: {
                  ...(maxAmount !== undefined ? { maxAmount } : {}),
                  ...(grantedRecipient !== undefined ? { recipient: grantedRecipient } : {}),
                  ...(flag !== undefined ? { allowUnlimited: flag } : {}),
                  asset: 'USDC',
                },
                action: {
                  ...(amount !== undefined ? { amount } : {}),
                  ...(actionRecipient !== undefined ? { recipient: actionRecipient } : {}),
                  ...(allowance !== undefined ? { allowance } : {}),
                },
              };
              rows.push({ mandate, mode: 'shadow' }, { mandate, mode: 'enforce' });
            }
          }
        }
      }
    }
  }
  return rows;
}

interface Composed {
  verdict: 'ALLOW' | 'BLOCK' | 'UNCERTAIN';
  promoted: boolean;
  reason: string | null;
}

function compose(
  promotion: ActionAuthPromotionDecision,
  gate: Pick<AuthorizationGateResult, 'enforcedVerdict' | 'checked' | 'skipped'>,
): Composed {
  if (gateEnforcedVerdict({ enforcedVerdict: gate.enforcedVerdict }) === 'BLOCK') {
    return { verdict: 'BLOCK', promoted: false, reason: null };
  }
  return {
    verdict: promotion.publicVerdict,
    promoted: promotion.promoted,
    reason: promotion.reason,
  };
}

describe('gate report verdict invariance', () => {
  const rows = gateMatrix();

  it('keeps the portable verifier enum aligned with the gate', () => {
    expect([...GATE_REPORT_KINDS]).toEqual([...GATE_VIOLATION_KINDS]);
    expect([...GATE_REPORT_SKIP_REASONS]).toEqual([...GATE_SKIP_REASONS]);
  });

  it('matches the pre-report decision across the gate matrix', () => {
    const mismatches: string[] = [];
    for (const row of rows) {
      const live = runAuthorizationGate(row.mandate, row.mode);
      const before = legacyDecision(row.mandate, row.mode);
      const after = decisionOf(live);
      const partition = new Set<string>([
        ...live.checked,
        ...live.skipped.map((skip) => skip.kind),
      ]);
      const reportOk =
        live.checked.length + live.skipped.length === GATE_VIOLATION_KINDS.length &&
        partition.size === GATE_VIOLATION_KINDS.length &&
        live.checked.every((kind) => GATE_VIOLATION_KINDS.includes(kind)) &&
        live.skipped.every((skip) => GATE_SKIP_REASONS.includes(skip.reason));
      const same =
        after.wouldBlock === before.wouldBlock &&
        after.enforcedVerdict === before.enforcedVerdict &&
        after.silent === before.silent &&
        after.kinds.join(',') === before.kinds.join(',');
      const override = gateEnforcedVerdict(live);
      const reportFilled: AuthorizationGateResult = {
        ...live,
        checked: [...GATE_VIOLATION_KINDS],
        skipped: [],
      };
      const reportErrored: AuthorizationGateResult = {
        ...live,
        checked: [],
        skipped: GATE_VIOLATION_KINDS.map((kind) => ({ kind, reason: 'gate_error' as const })),
      };
      const overrideIgnoresReport =
        gateEnforcedVerdict(reportFilled) === override &&
        gateEnforcedVerdict(reportErrored) === override;
      if (!same || !reportOk || !overrideIgnoresReport || (override !== 'BLOCK' && override !== null)) {
        mismatches.push(JSON.stringify({ before, after, override, reportOk, overrideIgnoresReport }));
        if (mismatches.length >= 3) break;
      }
      if (live.enforcedVerdict === 'ALLOW') {
        mismatches.push('enforcedVerdict ALLOW');
        break;
      }
    }
    expect(mismatches).toEqual([]);
    expect(rows.length).toBeGreaterThan(1000);
  });

  it('keeps promotion and the composed verdict identical when the report changes', () => {
    const passing = [
      { step_id: 'step_0', score: 0.9, predicate: 'supported' },
      { step_id: 'step_1', score: 0.9, predicate: 'supported' },
      { step_id: 'step_2', score: 0.9, predicate: 'supported' },
      { step_id: 'step_3', score: 0.9, predicate: 'supported' },
    ];
    const failing = [{ step_id: 'step_0', score: 0.1, predicate: 'unsupported' }];
    const promotions: ActionAuthPromotionDecision[] = [];
    for (const internalVerdict of ['ALLOW', 'BLOCK', 'HOLD', 'CONDITIONAL_ALLOW', 'DISSENT'] as const) {
      for (const cascadeReason of [
        null,
        'agreement_allow',
        'primary_error_fallback',
        'secondary_error_fallback',
        'primary_block_rejected',
        'agreement_conditional_allow',
      ] as const) {
        for (const degradedMode of [false, true]) {
          for (const steps of [passing, failing]) {
            const input = {
              mode: 'action_authorization' as const,
              internalVerdict,
              cascadeReason,
              degradedMode,
              mappedVerdict: mapVerdict(internalVerdict, 'action_authorization'),
              steps,
            };
            const first = resolveActionAuthPromotion(input);
            const second = resolveActionAuthPromotion(input);
            if (JSON.stringify(first) !== JSON.stringify(second)) {
              throw new Error('promotion is not deterministic');
            }
            promotions.push(first);
          }
        }
      }
    }

    const samples = rows.filter((_, index) => index % 17 === 0);
    expect(samples.length).toBeGreaterThan(50);
    const mismatches: string[] = [];
    for (const row of samples) {
      const live = runAuthorizationGate(row.mandate, row.mode);
      const before = legacyDecision(row.mandate, row.mode);
      const cleared: AuthorizationGateResult = { ...live, checked: [], skipped: [] };
      const filled: AuthorizationGateResult = {
        ...live,
        checked: [...GATE_VIOLATION_KINDS],
        skipped: [],
      };
      for (const promotion of promotions) {
        const after = compose(promotion, live);
        const withoutReport = compose(promotion, cleared);
        const withFullReport = compose(promotion, filled);
        const legacyComposed = compose(promotion, {
          enforcedVerdict: before.enforcedVerdict,
          checked: [],
          skipped: [],
        });
        if (
          JSON.stringify(after) !== JSON.stringify(withoutReport) ||
          JSON.stringify(after) !== JSON.stringify(withFullReport) ||
          JSON.stringify(after) !== JSON.stringify(legacyComposed)
        ) {
          mismatches.push(JSON.stringify({ after, withoutReport, legacyComposed, reason: promotion.reason }));
          break;
        }
      }
      if (mismatches.length > 0) break;
    }
    expect(mismatches).toEqual([]);
  });

  it('does not let UNCERTAIN or an evaluator error become ALLOW', () => {
    const passing = [
      { step_id: 'step_0', score: 0.9, predicate: 'supported' },
      { step_id: 'step_1', score: 0.9, predicate: 'supported' },
      { step_id: 'step_2', score: 0.9, predicate: 'supported' },
      { step_id: 'step_3', score: 0.9, predicate: 'supported' },
    ];
    const failClosed = [
      resolveActionAuthPromotion({
        mode: 'action_authorization',
        internalVerdict: 'HOLD',
        mappedVerdict: 'UNCERTAIN',
        steps: passing,
      }),
      resolveActionAuthPromotion({
        mode: 'action_authorization',
        internalVerdict: 'DISSENT',
        mappedVerdict: mapVerdict('DISSENT', 'action_authorization'),
        steps: passing,
      }),
      resolveActionAuthPromotion({
        mode: 'action_authorization',
        internalVerdict: 'CONDITIONAL_ALLOW',
        cascadeReason: 'agreement_conditional_allow',
        mappedVerdict: 'ALLOW',
        steps: passing,
      }),
      resolveActionAuthPromotion({
        mode: 'action_authorization',
        internalVerdict: 'ALLOW',
        cascadeReason: 'primary_error_fallback',
        degradedMode: true,
        mappedVerdict: 'ALLOW',
        steps: passing,
      }),
      resolveActionAuthPromotion({
        mode: 'action_authorization',
        internalVerdict: 'ALLOW',
        cascadeReason: 'secondary_error_fallback',
        mappedVerdict: 'ALLOW',
        steps: passing,
      }),
      resolveActionAuthPromotion({
        mode: 'action_authorization',
        internalVerdict: 'BLOCK',
        cascadeReason: 'primary_error_fallback',
        degradedMode: true,
        mappedVerdict: 'BLOCK',
        steps: [],
      }),
      resolveActionAuthPromotion({
        mode: 'action_authorization',
        internalVerdict: 'ALLOW',
        cascadeReason: 'primary_block_rejected',
        mappedVerdict: 'ALLOW',
        steps: passing,
      }),
    ];
    for (const promotion of failClosed) {
      expect(promotion.publicVerdict).not.toBe('ALLOW');
    }
    const gates = [
      runAuthorizationGate(undefined, 'enforce'),
      runAuthorizationGate(
        {
          granted: { maxAmount: 200, recipient: '0xACME', allowUnlimited: false },
          action: { amount: 2000, recipient: '0xBAD', allowance: 'MAX_UINT256' },
        },
        'enforce',
      ),
      runAuthorizationGate(
        {
          granted: { maxAmount: 200, recipient: '0xACME' },
          action: { amount: 200, recipient: '0xACME' },
        },
        'shadow',
      ),
    ];
    for (const promotion of failClosed) {
      for (const gate of gates) {
        const verdict = compose(promotion, gate).verdict;
        expect(verdict).not.toBe('ALLOW');
        const rewritten = compose(promotion, {
          ...gate,
          checked: [...GATE_VIOLATION_KINDS],
          skipped: [],
        }).verdict;
        expect(rewritten).toBe(verdict);
        expect(rewritten).not.toBe('ALLOW');
      }
    }
  });

  it('leaves 401, 429, and 5xx as refusals with no verdict', () => {
    const handler = readFileSync('api/sentinel/verify.ts', 'utf8');
    expect(handler).toContain('res.status(401)');
    expect(handler).toContain('res.status(429)');
    expect(handler).toContain('res.status(500)');
    expect(handler).not.toContain('checked');
    expect(handler).not.toContain('skipped');
    const refusals = [
      { status: 401, body: { error: 'Missing or invalid API key', code: 'UNAUTHORIZED' } },
      { status: 429, body: { error: 'Rate limit exceeded', code: 'RATE_LIMITED', remaining: 0 } },
      { status: 500, body: { error: 'internal', code: 'INTERNAL_ERROR', request_id: 'req' } },
      { status: 503, body: modelConfigUnavailablePayload('req') },
      { status: 503, body: rateLimitUnavailablePayload('req') },
    ];
    for (const refusal of refusals) {
      expect(refusal.status === 401 || refusal.status === 429 || refusal.status >= 500).toBe(true);
      expect(refusal.body).not.toHaveProperty('verdict');
      expect(JSON.stringify(refusal.body)).not.toContain('ALLOW');
    }
  });
});
