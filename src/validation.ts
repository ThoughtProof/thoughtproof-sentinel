import type { SentinelVerifyRequest, SentinelMode, SentinelTier } from './types.js';
import { TIER_CONFIGS } from './tiers.js';

export interface ValidationError {
  field: string;
  message: string;
}

const VALID_MODES: SentinelMode[] = ['handoff', 'plan_revision', 'memory_write', 'output_synthesis', 'trade_execution', 'trade_reasoning'];
const VALID_TIERS: SentinelTier[] = ['checkpoint', 'standard', 'swift'];

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
    },
  };
}
