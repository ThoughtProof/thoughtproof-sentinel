/**
 * ADR-0020 A1 pilot producer (single controlled client).
 *
 * Builds bounded, structured verify payloads for measurement only.
 * - canonical action_hash (0x+64 hex)
 * - required_conditions whitelist only (no valid_bound_evidence_count)
 * - no raw evidence packs / PII / secrets
 * - caller_asserted structure only (labels in agent_context tags)
 * - does NOT enable SHADOW_ADR0020; does NOT change verdict/cascade/policy
 */

import { createHash } from 'node:crypto';
import type { EvidenceBinding, RequiredCondition, SentinelVerifyRequest } from '../types.js';

export const PILOT_PRODUCER_ID = 'adr0020.a1.pilot.v0';
export const PILOT_MAX_CONDITIONS = 8;
export const PILOT_MAX_BINDINGS_PER_CONDITION = 4;
export const ACTION_HASH_RE = /^0x[a-f0-9]{64}$/;
const CONDITION_ID_RE = /^[a-z][a-z0-9_]{1,63}$/;
const EVIDENCE_ID_RE = /^evidence:[a-z0-9][a-z0-9_-]{1,63}$/;
const VALID_PROOF = new Set(['machine', 'any', 'none']);
const VALID_FRESHNESS = new Set(['fresh', 'current', 'stale', 'expired', 'unknown']);
const VALID_GRADES = new Set(['machine', 'human', 'unspecified']);

export type PilotBuildStatus = 'ok' | 'invalid';

export interface PilotBuildError {
  field: string;
  message: string;
}

export interface PilotCaseInput {
  /** Stable measurement case id (not used for routing). */
  case_id?: string;
  /** Optional precomputed canonical hash; otherwise derived from structure. */
  action_hash?: string;
  required_conditions?: unknown;
  /** Optional short synthetic claim; never raw mandate text from external systems. */
  claim?: string;
  evidence?: string;
  mode?: SentinelVerifyRequest['mode'];
  tier?: SentinelVerifyRequest['tier'];
}

export interface PilotBuildResult {
  status: PilotBuildStatus;
  errors: PilotBuildError[];
  /** Present only when status=ok — safe to POST to /sentinel/verify */
  request?: SentinelVerifyRequest;
  meta: {
    producer_id: string;
    case_id: string | null;
    condition_count: number;
    binding_count: number;
    action_hash: string | null;
    stripped_fields: string[];
  };
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Canonical action_hash: 0x + 64 lowercase hex. */
export function canonicalizeActionHash(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  if (!ACTION_HASH_RE.test(t)) return null;
  return t;
}

/**
 * Derive a deterministic canonical hash from structure when pack hash missing/invalid.
 * Material is structure-only (no free-text claim/evidence content).
 */
export function deriveActionHashFromStructure(
  conditions: RequiredCondition[],
  caseId?: string | null,
): string {
  const material = JSON.stringify({
    v: PILOT_PRODUCER_ID,
    case_id: caseId ?? null,
    conditions: conditions.map((c) => ({
      condition_id: c.condition_id,
      required: c.required,
      proof_requirement: c.proof_requirement,
      evidence_bindings: (c.evidence_bindings ?? []).map((b) => ({
        evidence_id: b.evidence_id,
        bound_condition_id: b.bound_condition_id,
        syntactically_valid: b.syntactically_valid,
        freshness: b.freshness,
        contradicted: b.contradicted,
        grade: b.grade,
      })),
    })),
  });
  return `0x${sha256Hex(material)}`;
}

function stripAndBuildBinding(
  raw: unknown,
  path: string,
  errors: PilotBuildError[],
  stripped: string[],
): EvidenceBinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ field: path, message: 'Must be an object' });
    return null;
  }
  const b = raw as Record<string, unknown>;
  const allowed = new Set([
    'evidence_id',
    'bound_condition_id',
    'syntactically_valid',
    'freshness',
    'contradicted',
    'grade',
    'valid_bound', // accepted only to strip — not forwarded
  ]);
  for (const key of Object.keys(b)) {
    if (!allowed.has(key)) {
      errors.push({ field: `${path}.${key}`, message: `Unknown field "${key}"` });
    }
  }
  if ('valid_bound' in b) stripped.push(`${path}.valid_bound`);
  // also strip any sneaky payload-ish keys if present under aliases
  for (const bad of ['raw', 'content', 'text', 'payload', 'secret', 'pii']) {
    if (bad in b) {
      errors.push({ field: `${path}.${bad}`, message: 'Raw/PII fields forbidden' });
    }
  }

  if (typeof b.evidence_id !== 'string' || !EVIDENCE_ID_RE.test(b.evidence_id)) {
    errors.push({
      field: `${path}.evidence_id`,
      message: 'Must match ^evidence:[a-z0-9][a-z0-9_-]{1,63}$',
    });
    return null;
  }
  if (typeof b.bound_condition_id !== 'string' || !CONDITION_ID_RE.test(b.bound_condition_id)) {
    errors.push({
      field: `${path}.bound_condition_id`,
      message: 'Must match condition_id pattern',
    });
    return null;
  }
  if (typeof b.syntactically_valid !== 'boolean') {
    errors.push({ field: `${path}.syntactically_valid`, message: 'Must be boolean' });
    return null;
  }
  if (typeof b.freshness !== 'string' || !VALID_FRESHNESS.has(b.freshness)) {
    errors.push({ field: `${path}.freshness`, message: 'Invalid freshness' });
    return null;
  }
  if (typeof b.contradicted !== 'boolean') {
    errors.push({ field: `${path}.contradicted`, message: 'Must be boolean' });
    return null;
  }
  if (typeof b.grade !== 'string' || !VALID_GRADES.has(b.grade)) {
    errors.push({ field: `${path}.grade`, message: 'Invalid grade' });
    return null;
  }

  return {
    evidence_id: b.evidence_id,
    bound_condition_id: b.bound_condition_id,
    syntactically_valid: b.syntactically_valid,
    freshness: b.freshness as EvidenceBinding['freshness'],
    contradicted: b.contradicted,
    grade: b.grade as EvidenceBinding['grade'],
  };
}

function stripAndBuildCondition(
  raw: unknown,
  path: string,
  errors: PilotBuildError[],
  stripped: string[],
  seenIds: Set<string>,
): RequiredCondition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ field: path, message: 'Must be an object' });
    return null;
  }
  const c = raw as Record<string, unknown>;
  const allowed = new Set([
    'condition_id',
    'required',
    'proof_requirement',
    'evidence_bindings',
    'valid_bound_evidence_count', // strip only
  ]);
  for (const key of Object.keys(c)) {
    if (!allowed.has(key)) {
      errors.push({ field: `${path}.${key}`, message: `Unknown field "${key}"` });
    }
  }
  if ('valid_bound_evidence_count' in c) {
    stripped.push(`${path}.valid_bound_evidence_count`);
  }

  if (typeof c.condition_id !== 'string' || !CONDITION_ID_RE.test(c.condition_id)) {
    errors.push({ field: `${path}.condition_id`, message: 'Invalid condition_id' });
    return null;
  }
  if (seenIds.has(c.condition_id)) {
    errors.push({ field: `${path}.condition_id`, message: `duplicate condition_id "${c.condition_id}"` });
    return null;
  }
  seenIds.add(c.condition_id);
  if (typeof c.required !== 'boolean') {
    errors.push({ field: `${path}.required`, message: 'Must be boolean' });
    return null;
  }
  if (typeof c.proof_requirement !== 'string' || !VALID_PROOF.has(c.proof_requirement)) {
    errors.push({ field: `${path}.proof_requirement`, message: 'Must be machine|any|none' });
    return null;
  }

  let evidence_bindings: EvidenceBinding[] | undefined;
  if (c.evidence_bindings !== undefined) {
    if (!Array.isArray(c.evidence_bindings)) {
      errors.push({ field: `${path}.evidence_bindings`, message: 'Must be an array' });
      return null;
    }
    if (c.evidence_bindings.length > PILOT_MAX_BINDINGS_PER_CONDITION) {
      errors.push({
        field: `${path}.evidence_bindings`,
        message: `Exceeds pilot max ${PILOT_MAX_BINDINGS_PER_CONDITION}`,
      });
      return null;
    }
    evidence_bindings = [];
    for (let j = 0; j < c.evidence_bindings.length; j++) {
      const b = stripAndBuildBinding(
        c.evidence_bindings[j],
        `${path}.evidence_bindings[${j}]`,
        errors,
        stripped,
      );
      if (b) evidence_bindings.push(b);
    }
  }

  return {
    condition_id: c.condition_id,
    required: c.required,
    proof_requirement: c.proof_requirement as RequiredCondition['proof_requirement'],
    ...(evidence_bindings ? { evidence_bindings } : {}),
  };
}

/**
 * Build one pilot verify request from a measurement-style case input.
 * Rejects missing/manipulated structure; never includes raw PII fields.
 */
export function buildPilotVerifyRequest(input: PilotCaseInput): PilotBuildResult {
  const errors: PilotBuildError[] = [];
  const stripped: string[] = [];
  const caseId = typeof input.case_id === 'string' && input.case_id.trim() ? input.case_id.trim() : null;

  if (input.required_conditions === undefined) {
    errors.push({ field: 'required_conditions', message: 'Required for pilot producer' });
  } else if (!Array.isArray(input.required_conditions)) {
    errors.push({ field: 'required_conditions', message: 'Must be an array' });
  } else if (input.required_conditions.length === 0) {
    errors.push({ field: 'required_conditions', message: 'Must be non-empty for pilot' });
  } else if (input.required_conditions.length > PILOT_MAX_CONDITIONS) {
    errors.push({
      field: 'required_conditions',
      message: `Exceeds pilot max ${PILOT_MAX_CONDITIONS}`,
    });
  }

  const seen = new Set<string>();
  const conditions: RequiredCondition[] = [];
  if (Array.isArray(input.required_conditions)) {
    const limit = Math.min(input.required_conditions.length, PILOT_MAX_CONDITIONS + 1);
    for (let i = 0; i < limit && i < input.required_conditions.length; i++) {
      if (i >= PILOT_MAX_CONDITIONS) break;
      const c = stripAndBuildCondition(
        input.required_conditions[i],
        `required_conditions[${i}]`,
        errors,
        stripped,
        seen,
      );
      if (c) conditions.push(c);
    }
  }

  let action_hash = canonicalizeActionHash(input.action_hash);
  if (input.action_hash !== undefined && action_hash === null) {
    errors.push({
      field: 'action_hash',
      message: 'Must be 0x followed by exactly 64 hex characters',
    });
  }
  // If omitted or we still can derive after structure ok:
  if (action_hash === null && conditions.length > 0 && errors.length === 0) {
    action_hash = deriveActionHashFromStructure(conditions, caseId);
  }

  // Synthetic non-PII claim/evidence only — pilot never forwards external free text blobs.
  const claim =
    typeof input.claim === 'string' && input.claim.trim()
      ? input.claim.trim().slice(0, 200)
      : `A1 pilot structure probe${caseId ? ` ${caseId}` : ''}`;
  const evidence =
    typeof input.evidence === 'string' && input.evidence.trim()
      ? input.evidence.trim().slice(0, 200)
      : 'synthetic structure-only pilot evidence; no raw mandate';

  // Reject claim/evidence that look like secrets/PII
  for (const [field, val] of [
    ['claim', claim],
    ['evidence', evidence],
  ] as const) {
    if (/@|api[_-]?key|password|secret|0x[a-f0-9]{40}\b/i.test(val) && field === 'claim') {
      // allow short synthetic; block obvious secrets
      if (/api[_-]?key|password|secret/i.test(val)) {
        errors.push({ field, message: 'Looks like secret/PII — refused' });
      }
    }
    if (/api[_-]?key\s*=|password\s*=|secret\s*=/i.test(val)) {
      errors.push({ field, message: 'Looks like secret/PII — refused' });
    }
  }

  const binding_count = conditions.reduce(
    (n, c) => n + (c.evidence_bindings?.length ?? 0),
    0,
  );

  if (errors.length > 0) {
    return {
      status: 'invalid',
      errors,
      meta: {
        producer_id: PILOT_PRODUCER_ID,
        case_id: caseId,
        condition_count: conditions.length,
        binding_count,
        action_hash,
        stripped_fields: stripped,
      },
    };
  }

  if (!action_hash) {
    return {
      status: 'invalid',
      errors: [{ field: 'action_hash', message: 'Could not canonicalize or derive' }],
      meta: {
        producer_id: PILOT_PRODUCER_ID,
        case_id: caseId,
        condition_count: conditions.length,
        binding_count,
        action_hash: null,
        stripped_fields: stripped,
      },
    };
  }

  const request: SentinelVerifyRequest = {
    id: caseId ? `pilot_${caseId}` : undefined,
    claim,
    evidence,
    mode: input.mode ?? 'action_authorization',
    tier: input.tier ?? 'swift',
    action_hash,
    required_conditions: conditions,
    agent_context: {
      agent_id: PILOT_PRODUCER_ID,
      agent_runtime: 'a1-pilot',
      environment: 'paper',
      tags: [
        'adr0020',
        'a1-pilot',
        'caller_asserted',
        'flag_off_safe',
        ...(caseId ? [`case:${caseId}`] : []),
      ],
    },
  };

  return {
    status: 'ok',
    errors: [],
    request,
    meta: {
      producer_id: PILOT_PRODUCER_ID,
      case_id: caseId,
      condition_count: conditions.length,
      binding_count,
      action_hash,
      stripped_fields: stripped,
    },
  };
}

/** Load measurement pack JSONL lines into pilot inputs (structure fields only). */
export function measurementLineToPilotInput(line: unknown): PilotCaseInput {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return {};
  const o = line as Record<string, unknown>;
  return {
    case_id: typeof o.case_id === 'string' ? o.case_id : undefined,
    action_hash: typeof o.action_hash === 'string' ? o.action_hash : undefined,
    required_conditions: o.required_conditions,
    // never take claim/evidence/oracle/gold from pack free text
  };
}
