import type { AgentContext, SentinelVerifyRequest, SentinelMode, SentinelTier } from './types.js';
import type { AuthorizationMandate, GateMode } from './engine/authorization-gate.js';
import { TIER_CONFIGS } from './tiers.js';

export interface ValidationError {
  field: string;
  message: string;
}

const VALID_MODES: SentinelMode[] = ['handoff', 'plan_revision', 'memory_write', 'output_synthesis', 'trade_execution', 'trade_reasoning', 'action_authorization'];
// Derived from TIER_CONFIGS (includes hidden tiers swift/pro) so /verify accepts
// any routable tier while /tiers only advertises the public ones.
const VALID_TIERS = Object.keys(TIER_CONFIGS) as SentinelTier[];
const VALID_GATE_MODES: GateMode[] = ['shadow', 'enforce'];
const VALID_ENVIRONMENTS = ['paper', 'testnet', 'live', 'dev'] as const;
const VALID_IDENTITY_SOURCES = ['operator_declared', 'erc8004_registry', 'api_key_binding'] as const;
const VALID_MODEL_SOURCES = ['operator_declared', 'runtime_detected', 'unknown'] as const;
const VALID_MODEL_ROLES = ['action_generator', 'planner', 'tool_caller', 'other'] as const;
const MAX_AGENT_CONTEXT_STRING = 256;
const MAX_AGENT_CONTEXT_TAGS = 16;

function parseAgentContext(
  raw: unknown,
  errors: ValidationError[],
): AgentContext | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push({ field: 'agent_context', message: 'Must be an object' });
    return undefined;
  }
  const a = raw as Record<string, unknown>;
  const out: AgentContext = {};

  const strField = (key: string, value: unknown) => {
    if (value === undefined) return;
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push({ field: `agent_context.${key}`, message: 'Must be a non-empty string' });
      return;
    }
    if (value.length > MAX_AGENT_CONTEXT_STRING) {
      errors.push({
        field: `agent_context.${key}`,
        message: `Exceeds ${MAX_AGENT_CONTEXT_STRING} character limit`,
      });
      return;
    }
    (out as Record<string, string>)[key] = value.trim();
  };

  strField('agent_id', a.agent_id);
  strField('agent_model', a.agent_model);
  strField('agent_model_provider', a.agent_model_provider);
  strField('agent_runtime', a.agent_runtime);
  strField('skill_version', a.skill_version);
  strField('session_id', a.session_id);
  // Prefer external_request_id; accept legacy request_id
  strField('external_request_id', a.external_request_id ?? a.request_id);

  if (a.environment !== undefined) {
    if (typeof a.environment !== 'string' || !VALID_ENVIRONMENTS.includes(a.environment as typeof VALID_ENVIRONMENTS[number])) {
      errors.push({
        field: 'agent_context.environment',
        message: `Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`,
      });
    } else {
      out.environment = a.environment as AgentContext['environment'];
    }
  }

  if (a.identity_source !== undefined) {
    if (typeof a.identity_source !== 'string' || !VALID_IDENTITY_SOURCES.includes(a.identity_source as typeof VALID_IDENTITY_SOURCES[number])) {
      errors.push({
        field: 'agent_context.identity_source',
        message: `Must be one of: ${VALID_IDENTITY_SOURCES.join(', ')}`,
      });
    } else {
      out.identity_source = a.identity_source as AgentContext['identity_source'];
    }
  }

  if (a.identity_verified !== undefined) {
    if (typeof a.identity_verified !== 'boolean') {
      errors.push({ field: 'agent_context.identity_verified', message: 'Must be a boolean' });
    } else {
      out.identity_verified = a.identity_verified;
    }
  }

  if (a.agent_model_source !== undefined) {
    if (typeof a.agent_model_source !== 'string' || !VALID_MODEL_SOURCES.includes(a.agent_model_source as typeof VALID_MODEL_SOURCES[number])) {
      errors.push({
        field: 'agent_context.agent_model_source',
        message: `Must be one of: ${VALID_MODEL_SOURCES.join(', ')}`,
      });
    } else {
      out.agent_model_source = a.agent_model_source as AgentContext['agent_model_source'];
    }
  }

  if (a.agent_model_role !== undefined) {
    if (typeof a.agent_model_role !== 'string' || !VALID_MODEL_ROLES.includes(a.agent_model_role as typeof VALID_MODEL_ROLES[number])) {
      errors.push({
        field: 'agent_context.agent_model_role',
        message: `Must be one of: ${VALID_MODEL_ROLES.join(', ')}`,
      });
    } else {
      out.agent_model_role = a.agent_model_role as AgentContext['agent_model_role'];
    }
  }

  if (a.erc8004 !== undefined) {
    if (typeof a.erc8004 !== 'object' || a.erc8004 === null || Array.isArray(a.erc8004)) {
      errors.push({ field: 'agent_context.erc8004', message: 'Must be an object { chainId, tokenId }' });
    } else {
      const e = a.erc8004 as Record<string, unknown>;
      const chainId = e.chainId;
      const tokenId = e.tokenId;
      if (typeof chainId !== 'number' || !Number.isFinite(chainId) || chainId < 0) {
        errors.push({ field: 'agent_context.erc8004.chainId', message: 'Must be a non-negative number' });
      } else if (
        (typeof tokenId !== 'string' && typeof tokenId !== 'number') ||
        (typeof tokenId === 'string' && tokenId.trim().length === 0)
      ) {
        errors.push({ field: 'agent_context.erc8004.tokenId', message: 'Must be a non-empty string or number' });
      } else {
        out.erc8004 = {
          chainId,
          tokenId: typeof tokenId === 'string' ? tokenId.trim() : tokenId,
        };
      }
    }
  }

  if (a.tags !== undefined) {
    if (!Array.isArray(a.tags)) {
      errors.push({ field: 'agent_context.tags', message: 'Must be an array of short strings' });
    } else if (a.tags.length > MAX_AGENT_CONTEXT_TAGS) {
      errors.push({
        field: 'agent_context.tags',
        message: `At most ${MAX_AGENT_CONTEXT_TAGS} tags`,
      });
    } else {
      const tags: string[] = [];
      for (let i = 0; i < a.tags.length; i++) {
        const t = a.tags[i];
        if (typeof t !== 'string' || t.trim().length === 0 || t.length > 64) {
          errors.push({
            field: `agent_context.tags[${i}]`,
            message: 'Each tag must be a non-empty string ≤64 chars',
          });
        } else {
          tags.push(t.trim());
        }
      }
      if (tags.length > 0) out.tags = tags;
    }
  }

  // Defaults: never claim verification; mark self-reports explicitly
  if (out.agent_model && out.agent_model_source === undefined) {
    out.agent_model_source = 'operator_declared';
  }
  if (out.agent_model && out.agent_model_role === undefined) {
    out.agent_model_role = 'action_generator';
  }
  if ((out.agent_id || out.erc8004) && out.identity_source === undefined) {
    out.identity_source = 'operator_declared';
  }
  if ((out.agent_id || out.erc8004) && out.identity_verified === undefined) {
    out.identity_verified = false;
  }
  // Pilot: refuse identity_verified=true without non-declared source
  if (out.identity_verified === true && (out.identity_source === 'operator_declared' || out.identity_source === undefined)) {
    errors.push({
      field: 'agent_context.identity_verified',
      message: 'identity_verified=true requires identity_source erc8004_registry or api_key_binding',
    });
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function validateVerifyRequest(body: unknown): { valid: true; data: SentinelVerifyRequest } | { valid: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
  }

  const b = body as Record<string, unknown>;

  if (!b.claim || typeof b.claim !== 'string' || b.claim.trim().length === 0) {
    errors.push({ field: 'claim', message: 'Required non-empty string' });
  }
  if (!b.evidence || typeof b.evidence !== 'string' || b.evidence.trim().length === 0) {
    errors.push({ field: 'evidence', message: 'Required non-empty string' });
  }
  if (!b.mode || !VALID_MODES.includes(b.mode as SentinelMode)) {
    errors.push({ field: 'mode', message: `Required. Must be one of: ${VALID_MODES.join(', ')}` });
  }
  if (b.tier !== undefined && !VALID_TIERS.includes(b.tier as SentinelTier)) {
    errors.push({ field: 'tier', message: `Must be one of: ${VALID_TIERS.join(', ')}` });
  }
  if (b.id !== undefined && typeof b.id !== 'string') {
    errors.push({ field: 'id', message: 'Must be a string' });
  }
  if (b.gateMode !== undefined && !VALID_GATE_MODES.includes(b.gateMode as GateMode)) {
    errors.push({ field: 'gateMode', message: `Must be one of: ${VALID_GATE_MODES.join(', ')}` });
  }
  if (b.mandate !== undefined && (typeof b.mandate !== 'object' || b.mandate === null || Array.isArray(b.mandate))) {
    errors.push({ field: 'mandate', message: 'Must be an object with optional { granted, action }' });
  }

  const agent_context = parseAgentContext(b.agent_context, errors);

  // Size limits
  if (typeof b.claim === 'string' && b.claim.length > 100_000) {
    errors.push({ field: 'claim', message: 'Claim exceeds 100KB limit' });
  }
  if (typeof b.evidence === 'string' && b.evidence.length > 500_000) {
    errors.push({ field: 'evidence', message: 'Evidence exceeds 500KB limit' });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: {
      id: b.id as string | undefined,
      claim: (b.claim as string).trim(),
      evidence: (b.evidence as string).trim(),
      mode: b.mode as SentinelMode,
      tier: (b.tier as SentinelTier | undefined) ?? 'standard',
      mandate: normalizeMandate(b.mandate),
      gateMode: b.gateMode as GateMode | undefined,
      agent_context,
    },
  };
}

/**
 * Accept common aliases used in demos/docs (maxAmountUsd, amountUsd) so the
 * deterministic gate can fire. Prefer canonical maxAmount/amount when both set.
 */
function normalizeMandate(raw: unknown): AuthorizationMandate | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const m = raw as Record<string, unknown>;
  const grantedIn = (m.granted && typeof m.granted === 'object' && !Array.isArray(m.granted)
    ? (m.granted as Record<string, unknown>)
    : undefined);
  const actionIn = (m.action && typeof m.action === 'object' && !Array.isArray(m.action)
    ? (m.action as Record<string, unknown>)
    : undefined);

  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const granted = grantedIn
    ? {
        ...grantedIn,
        maxAmount:
          num(grantedIn.maxAmount) ??
          num(grantedIn.maxAmountUsd) ??
          num(grantedIn.max_amount),
        asset: typeof grantedIn.asset === 'string' ? grantedIn.asset : undefined,
        recipient: typeof grantedIn.recipient === 'string' ? grantedIn.recipient : undefined,
        allowUnlimited:
          typeof grantedIn.allowUnlimited === 'boolean' ? grantedIn.allowUnlimited : undefined,
      }
    : undefined;

  const action = actionIn
    ? {
        ...actionIn,
        amount:
          num(actionIn.amount) ?? num(actionIn.amountUsd) ?? num(actionIn.amount_usd),
        asset: typeof actionIn.asset === 'string' ? actionIn.asset : undefined,
        recipient: typeof actionIn.recipient === 'string' ? actionIn.recipient : undefined,
        allowance: actionIn.allowance as string | number | undefined,
      }
    : undefined;

  // Strip undefined-only shells
  const g =
    granted &&
    (granted.maxAmount !== undefined ||
      granted.asset !== undefined ||
      granted.recipient !== undefined ||
      granted.allowUnlimited !== undefined)
      ? {
          ...(granted.maxAmount !== undefined ? { maxAmount: granted.maxAmount } : {}),
          ...(granted.asset !== undefined ? { asset: granted.asset } : {}),
          ...(granted.recipient !== undefined ? { recipient: granted.recipient } : {}),
          ...(granted.allowUnlimited !== undefined
            ? { allowUnlimited: granted.allowUnlimited }
            : {}),
        }
      : undefined;
  const a =
    action &&
    (action.amount !== undefined ||
      action.asset !== undefined ||
      action.recipient !== undefined ||
      action.allowance !== undefined)
      ? {
          ...(action.amount !== undefined ? { amount: action.amount } : {}),
          ...(action.asset !== undefined ? { asset: action.asset } : {}),
          ...(action.recipient !== undefined ? { recipient: action.recipient } : {}),
          ...(action.allowance !== undefined ? { allowance: action.allowance } : {}),
        }
      : undefined;

  if (!g && !a) return m as AuthorizationMandate;
  return { granted: g, action: a };
}
