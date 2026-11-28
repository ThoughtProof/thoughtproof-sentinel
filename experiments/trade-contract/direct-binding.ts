import { BINDING_BUDGET_MS, gatewayStrong } from './direct-historical.ts';

/** Primary comparison arm. It reads the critic fields before the September rewrite. */
export const STRICT_BINDING_LABEL = 'historischer Critic + Gateway mit strikter Bindung' as const;

const TYPED_VERDICTS = ['ALLOW', 'BLOCK', 'REVIEW', 'UNCERTAIN'] as const;

export interface RawCriticFields {
  execute: unknown;
  verdict: unknown;
}

export interface SeptemberRuleResult {
  /** Secondary metric. This is the September envelope, not the strict executor. */
  label: 'september_rule';
  verdict: string;
  execute: boolean;
}

export interface StrictBindingResult {
  label: typeof STRICT_BINDING_LABEL;
  executed: boolean;
  protocolError: 'protocol_error' | null;
  gatewayPassed: boolean;
  criticReached: boolean;
  durationMs: number;
  september: SeptemberRuleResult | null;
}

function typed(raw: RawCriticFields | null): { execute: boolean; verdict: string } | null {
  if (!raw || typeof raw.execute !== 'boolean' || typeof raw.verdict !== 'string') return null;
  if (!(TYPED_VERDICTS as readonly string[]).includes(raw.verdict)) return null;
  return { execute: raw.execute, verdict: raw.verdict };
}

/**
 * Unchanged September envelope from critic_live.py, applied to the raw fields.
 * A true execute flag replaces the verdict word with ALLOW. This does not execute.
 */
export function septemberRule(
  raw: { execute: boolean; verdict: string },
  gatewayPassed: boolean,
): SeptemberRuleResult {
  let execute = Boolean(raw.execute) && gatewayPassed;
  const stated = raw.verdict || (execute ? 'ALLOW' : 'BLOCK');
  if (!raw.execute) execute = false;
  return { label: 'september_rule', verdict: execute ? 'ALLOW' : stated, execute };
}

/**
 * Execution requires a passed gateway, a typed critic answer, execute true,
 * verdict ALLOW, and at most 45 seconds. Contradictions and invalid fields
 * are protocol errors and do not execute.
 */
export function strictBinding(input: {
  world: Record<string, unknown> | undefined;
  action: Record<string, unknown>;
  durationMs: number;
  raw: RawCriticFields | null;
}): StrictBindingResult {
  const gate = gatewayStrong(input.world, input.action);
  if (!gate.execute) {
    return {
      label: STRICT_BINDING_LABEL,
      executed: false,
      protocolError: null,
      gatewayPassed: false,
      criticReached: false,
      durationMs: input.durationMs,
      september: null,
    };
  }
  const fields = typed(input.raw);
  if (!fields) {
    return {
      label: STRICT_BINDING_LABEL,
      executed: false,
      protocolError: 'protocol_error',
      gatewayPassed: true,
      criticReached: true,
      durationMs: input.durationMs,
      september: null,
    };
  }
  const september = septemberRule(fields, true);
  const contradictory = (fields.execute && fields.verdict !== 'ALLOW')
    || (!fields.execute && fields.verdict === 'ALLOW');
  if (contradictory) {
    return {
      label: STRICT_BINDING_LABEL,
      executed: false,
      protocolError: 'protocol_error',
      gatewayPassed: true,
      criticReached: true,
      durationMs: input.durationMs,
      september,
    };
  }
  const timely = Number.isFinite(input.durationMs) && input.durationMs >= 0 && input.durationMs <= BINDING_BUDGET_MS;
  return {
    label: STRICT_BINDING_LABEL,
    executed: fields.execute === true && fields.verdict === 'ALLOW' && timely,
    protocolError: null,
    gatewayPassed: true,
    criticReached: true,
    durationMs: input.durationMs,
    september,
  };
}
