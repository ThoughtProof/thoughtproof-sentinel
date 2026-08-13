import type { AgentContext, SentinelVerifyRequest, SentinelMode, SentinelTier, SignedEventEvidence, KeyManifest, RequiredCondition, EvidenceBinding } from './types.js';
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

/**
 * Strict field whitelists (F3).
 *
 * The /verify request body is action-bound: its `package_digest` is a
 * cryptographic commitment to the exact validated request. Silently dropping
 * unknown fields would let a caller believe extra fields are bound when they
 * are not — an interop trap and a subtle integrity gap. Instead we reject the
 * request with 400 and name the offending field(s).
 *
 * Scope of this whitelist: the top-level body and each `signed_evidence[i]`
 * item, i.e. the layers whose bytes flow directly into `computePackageDigest`.
 * Deeper nested objects (`agent_context`, `key_manifest`, `mandate`) already
 * validate their own fields explicitly and reconstruct clean output objects.
 */
const ALLOWED_BODY_FIELDS = new Set([
  'id', 'claim', 'evidence', 'mode', 'tier', 'mandate', 'gateMode',
  'agent_context', 'signed_evidence', 'key_manifest',
  // ADR-0020 shadow measurement (does not affect verdict)
  'required_conditions', 'action_hash',
]);
const VALID_PROOF_REQUIREMENTS = new Set(['machine', 'any', 'none']);
const VALID_FRESHNESS = new Set(['fresh', 'current', 'stale', 'expired', 'unknown']);
const VALID_GRADES = new Set(['machine', 'human', 'unspecified']);
const CONDITION_ID_RE = /^[a-z][a-z0-9_]{1,63}$/;
const EVIDENCE_ID_RE = /^evidence:[a-z0-9][a-z0-9_-]{1,63}$/;
const MAX_REQUIRED_CONDITIONS = 32;
const MAX_BINDINGS_PER_CONDITION = 16;
const ALLOWED_SIGNED_EVIDENCE_ITEM_FIELDS = new Set([
  'type', 'raw_event', 'signature_scheme', 'signer_pubkey',
  'claims', 'verification', 'key_manifest_ref',
]);

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

/**
 * ADR-0020 optional structured conditions. Does not affect verdict.
 * Reconstructs a clean object (strict nested whitelist).
 */
function parseRequiredConditions(
  raw: unknown,
  errors: ValidationError[],
): RequiredCondition[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push({ field: 'required_conditions', message: 'Must be an array' });
    return undefined;
  }
  if (raw.length > MAX_REQUIRED_CONDITIONS) {
    errors.push({
      field: 'required_conditions',
      message: `Exceeds max ${MAX_REQUIRED_CONDITIONS} conditions`,
    });
    return undefined;
  }

  const out: RequiredCondition[] = [];
  const seenConditionIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const base = `required_conditions[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ field: base, message: 'Must be an object' });
      continue;
    }
    const c = item as Record<string, unknown>;
    const allowed = new Set([
      'condition_id',
      'required',
      'proof_requirement',
      'evidence_bindings',
      // valid_bound_evidence_count intentionally NOT accepted (untrusted caller count)
    ]);
    for (const key of Object.keys(c)) {
      if (!allowed.has(key)) {
        errors.push({ field: `${base}.${key}`, message: `Unknown field "${key}"` });
      }
    }

    if (typeof c.condition_id !== 'string' || !CONDITION_ID_RE.test(c.condition_id)) {
      errors.push({
        field: `${base}.condition_id`,
        message: 'Must match ^[a-z][a-z0-9_]{1,63}$',
      });
      continue;
    }
    if (seenConditionIds.has(c.condition_id)) {
      errors.push({
        field: `${base}.condition_id`,
        message: `duplicate condition_id "${c.condition_id}"`,
      });
      continue;
    }
    seenConditionIds.add(c.condition_id);
    if (typeof c.required !== 'boolean') {
      errors.push({ field: `${base}.required`, message: 'Must be a boolean' });
      continue;
    }
    if (typeof c.proof_requirement !== 'string' || !VALID_PROOF_REQUIREMENTS.has(c.proof_requirement)) {
      errors.push({
        field: `${base}.proof_requirement`,
        message: 'Must be one of: machine, any, none',
      });
      continue;
    }

    let evidence_bindings: EvidenceBinding[] | undefined;
    if (c.evidence_bindings !== undefined) {
      if (!Array.isArray(c.evidence_bindings)) {
        errors.push({ field: `${base}.evidence_bindings`, message: 'Must be an array' });
        continue;
      }
      if (c.evidence_bindings.length > MAX_BINDINGS_PER_CONDITION) {
        errors.push({
          field: `${base}.evidence_bindings`,
          message: `Exceeds max ${MAX_BINDINGS_PER_CONDITION} bindings`,
        });
        continue;
      }
      evidence_bindings = [];
      for (let j = 0; j < c.evidence_bindings.length; j++) {
        const bRaw = c.evidence_bindings[j];
        const bBase = `${base}.evidence_bindings[${j}]`;
        if (!bRaw || typeof bRaw !== 'object' || Array.isArray(bRaw)) {
          errors.push({ field: bBase, message: 'Must be an object' });
          continue;
        }
        const b = bRaw as Record<string, unknown>;
        const bAllowed = new Set([
          'evidence_id',
          'bound_condition_id',
          'syntactically_valid',
          'freshness',
          'contradicted',
          'grade',
          'valid_bound',
        ]);
        for (const key of Object.keys(b)) {
          if (!bAllowed.has(key)) {
            errors.push({ field: `${bBase}.${key}`, message: `Unknown field "${key}"` });
          }
        }
        if (typeof b.evidence_id !== 'string' || !EVIDENCE_ID_RE.test(b.evidence_id)) {
          errors.push({
            field: `${bBase}.evidence_id`,
            message: 'Must match ^evidence:[a-z0-9][a-z0-9_-]{1,63}$',
          });
          continue;
        }
        if (typeof b.bound_condition_id !== 'string' || b.bound_condition_id.length === 0) {
          errors.push({ field: `${bBase}.bound_condition_id`, message: 'Required non-empty string' });
          continue;
        }
        if (typeof b.syntactically_valid !== 'boolean') {
          errors.push({ field: `${bBase}.syntactically_valid`, message: 'Must be a boolean' });
          continue;
        }
        if (typeof b.freshness !== 'string' || !VALID_FRESHNESS.has(b.freshness)) {
          errors.push({
            field: `${bBase}.freshness`,
            message: 'Must be one of: fresh, current, stale, expired, unknown',
          });
          continue;
        }
        if (typeof b.contradicted !== 'boolean') {
          errors.push({ field: `${bBase}.contradicted`, message: 'Must be a boolean' });
          continue;
        }
        if (typeof b.grade !== 'string' || !VALID_GRADES.has(b.grade)) {
          errors.push({
            field: `${bBase}.grade`,
            message: 'Must be one of: machine, human, unspecified',
          });
          continue;
        }
        const binding: EvidenceBinding = {
          evidence_id: b.evidence_id,
          bound_condition_id: b.bound_condition_id,
          syntactically_valid: b.syntactically_valid,
          freshness: b.freshness as EvidenceBinding['freshness'],
          contradicted: b.contradicted,
          grade: b.grade as EvidenceBinding['grade'],
        };
        if (b.valid_bound !== undefined) {
          if (typeof b.valid_bound !== 'boolean') {
            errors.push({ field: `${bBase}.valid_bound`, message: 'Must be a boolean' });
            continue;
          }
          binding.valid_bound = b.valid_bound;
        }
        evidence_bindings.push(binding);
      }
    }

    // valid_bound_evidence_count is rejected via allowed-set (untrusted caller count).
    const cond: RequiredCondition = {
      condition_id: c.condition_id,
      required: c.required,
      proof_requirement: c.proof_requirement as RequiredCondition['proof_requirement'],
    };
    if (evidence_bindings !== undefined) cond.evidence_bindings = evidence_bindings;
    out.push(cond);
  }

  return out;
}

export function validateVerifyRequest(body: unknown): { valid: true; data: SentinelVerifyRequest } | { valid: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
  }

  const b = body as Record<string, unknown>;

  // F3: strict body whitelist. Unknown top-level fields would be silently
  // stripped by the validator and thus not committed to the package_digest,
  // which would break the action-bound guarantee. Reject them explicitly.
  for (const key of Object.keys(b)) {
    if (!ALLOWED_BODY_FIELDS.has(key)) {
      errors.push({ field: key, message: `Unknown field "${key}" — not allowed at request body top level. Allowed: ${[...ALLOWED_BODY_FIELDS].sort().join(', ')}` });
    }
  }

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

  // Validate signed evidence (F1)
  const signedEvidence = validateSignedEvidence(b.signed_evidence, errors);
  const keyManifest = validateKeyManifest(b.key_manifest, errors);

  const agent_context = parseAgentContext(b.agent_context, errors);
  const required_conditions = parseRequiredConditions(b.required_conditions, errors);

  if (b.action_hash !== undefined) {
    if (typeof b.action_hash !== 'string' || b.action_hash.trim().length === 0) {
      errors.push({ field: 'action_hash', message: 'Must be a non-empty string when provided' });
    } else if (b.action_hash.length > 128) {
      errors.push({ field: 'action_hash', message: 'Exceeds 128 character limit' });
    }
  }

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
      signed_evidence: signedEvidence,
      key_manifest: keyManifest,
      ...(required_conditions !== undefined ? { required_conditions } : {}),
      ...(typeof b.action_hash === 'string' ? { action_hash: b.action_hash.trim() } : {}),
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

/**
 * Validate signed evidence array (F1).
 */
function validateSignedEvidence(
  raw: unknown,
  errors: ValidationError[],
): SignedEventEvidence[] | undefined {
  if (raw === undefined) return undefined;

  if (!Array.isArray(raw)) {
    errors.push({ field: 'signed_evidence', message: 'Must be an array of signed event objects' });
    return undefined;
  }

  if (raw.length > 50) {
    errors.push({ field: 'signed_evidence', message: 'At most 50 evidence items allowed' });
    return undefined;
  }

  const evidence: SignedEventEvidence[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ field: `signed_evidence[${i}]`, message: 'Must be an object' });
      continue;
    }

    const e = item as Record<string, unknown>;

    // F3: strict per-item whitelist. See top-of-file comment on
    // ALLOWED_SIGNED_EVIDENCE_ITEM_FIELDS — unknown fields here would be
    // silently stripped and thus not enter the package_digest.
    for (const key of Object.keys(e)) {
      if (!ALLOWED_SIGNED_EVIDENCE_ITEM_FIELDS.has(key)) {
        errors.push({
          field: `signed_evidence[${i}].${key}`,
          message: `Unknown field "${key}" — not allowed on a signed_evidence item. Allowed: ${[...ALLOWED_SIGNED_EVIDENCE_ITEM_FIELDS].sort().join(', ')}`,
        });
      }
    }

    if (e.type !== 'signed_event') {
      errors.push({ field: `signed_evidence[${i}].type`, message: 'Must be "signed_event"' });
      continue;
    }

    if (typeof e.raw_event !== 'string' || e.raw_event.length === 0) {
      errors.push({ field: `signed_evidence[${i}].raw_event`, message: 'Must be a non-empty base64 string' });
      continue;
    }

    if (e.signature_scheme !== 'ed25519') {
      errors.push({ 
        field: `signed_evidence[${i}].signature_scheme`, 
        message: 'Must be "ed25519" (only supported scheme in v0)' 
      });
      continue;
    }

    if (typeof e.signer_pubkey !== 'string' || !/^[0-9a-f]+$/i.test(e.signer_pubkey)) {
      errors.push({ 
        field: `signed_evidence[${i}].signer_pubkey`, 
        message: 'Must be a hex-encoded public key' 
      });
      continue;
    }

    if (e.signer_pubkey.length !== 64) {
      errors.push({ 
        field: `signed_evidence[${i}].signer_pubkey`, 
        message: 'Ed25519 public key must be 32 bytes (64 hex chars)' 
      });
      continue;
    }

    if (!Array.isArray(e.claims) || e.claims.length === 0) {
      errors.push({ field: `signed_evidence[${i}].claims`, message: 'Must be a non-empty array of claim strings' });
      continue;
    }

    const claims: string[] = [];
    for (let j = 0; j < e.claims.length; j++) {
      const claim = e.claims[j];
      if (typeof claim !== 'string' || claim.trim().length === 0) {
        errors.push({ 
          field: `signed_evidence[${i}].claims[${j}]`, 
          message: 'Each claim must be a non-empty string' 
        });
      } else {
        claims.push(claim.trim());
      }
    }

    if (e.verification !== 'required' && e.verification !== 'optional') {
      errors.push({ 
        field: `signed_evidence[${i}].verification`, 
        message: 'Must be "required" or "optional"' 
      });
      continue;
    }

    if (e.key_manifest_ref !== undefined && typeof e.key_manifest_ref !== 'string') {
      errors.push({ 
        field: `signed_evidence[${i}].key_manifest_ref`, 
        message: 'Must be a string when provided' 
      });
      continue;
    }

    evidence.push({
      type: 'signed_event',
      raw_event: e.raw_event,
      signature_scheme: 'ed25519',
      signer_pubkey: e.signer_pubkey.toLowerCase(),
      claims,
      verification: e.verification as 'required' | 'optional',
      ...(e.key_manifest_ref ? { key_manifest_ref: e.key_manifest_ref as string } : {}),
    });
  }

  return evidence.length > 0 ? evidence : undefined;
}

/**
 * Validate key manifest (F1).
 */
function validateKeyManifest(
  raw: unknown,
  errors: ValidationError[],
): KeyManifest | undefined {
  if (raw === undefined) return undefined;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ field: 'key_manifest', message: 'Must be an object' });
    return undefined;
  }

  const m = raw as Record<string, unknown>;

  if (typeof m.version !== 'string' || m.version.trim().length === 0) {
    errors.push({ field: 'key_manifest.version', message: 'Must be a non-empty string' });
  }

  if (!Array.isArray(m.keys)) {
    errors.push({ field: 'key_manifest.keys', message: 'Must be an array of key objects' });
    return undefined;
  }

  if (m.keys.length > 100) {
    errors.push({ field: 'key_manifest.keys', message: 'At most 100 keys allowed' });
    return undefined;
  }

  const keys = [];

  for (let i = 0; i < m.keys.length; i++) {
    const key = m.keys[i];
    if (!key || typeof key !== 'object' || Array.isArray(key)) {
      errors.push({ field: `key_manifest.keys[${i}]`, message: 'Must be an object' });
      continue;
    }

    const k = key as Record<string, unknown>;

    if (typeof k.pubkey !== 'string' || !/^[0-9a-f]+$/i.test(k.pubkey) || k.pubkey.length !== 64) {
      errors.push({ 
        field: `key_manifest.keys[${i}].pubkey`, 
        message: 'Must be a 64-char hex-encoded ed25519 public key' 
      });
      continue;
    }

    if (!['active', 'revoked', 'rotated'].includes(k.status as string)) {
      errors.push({ 
        field: `key_manifest.keys[${i}].status`, 
        message: 'Must be "active", "revoked", or "rotated"' 
      });
      continue;
    }

    const keyEntry: any = {
      pubkey: k.pubkey.toLowerCase(),
      status: k.status,
    };

    if (k.not_before !== undefined) {
      if (typeof k.not_before !== 'string') {
        errors.push({ field: `key_manifest.keys[${i}].not_before`, message: 'Must be an ISO date string' });
        continue;
      }
      keyEntry.not_before = k.not_before;
    }

    if (k.not_after !== undefined) {
      if (typeof k.not_after !== 'string') {
        errors.push({ field: `key_manifest.keys[${i}].not_after`, message: 'Must be an ISO date string' });
        continue;
      }
      keyEntry.not_after = k.not_after;
    }

    if (k.roles !== undefined) {
      if (!Array.isArray(k.roles)) {
        errors.push({ field: `key_manifest.keys[${i}].roles`, message: 'Must be an array of role strings' });
        continue;
      }
      const roles: string[] = [];
      for (let j = 0; j < k.roles.length; j++) {
        const role = k.roles[j];
        if (typeof role !== 'string' || role.trim().length === 0) {
          errors.push({ 
            field: `key_manifest.keys[${i}].roles[${j}]`, 
            message: 'Each role must be a non-empty string' 
          });
        } else {
          roles.push(role.trim());
        }
      }
      if (roles.length > 0) keyEntry.roles = roles;
    }

    keys.push(keyEntry);
  }

  return {
    version: (m.version as string).trim(),
    keys,
  };
}
