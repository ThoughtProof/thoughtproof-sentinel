/**
 * Verdict Mapper
 *
 * Maps pot-cli's internal verdict vocabulary to Sentinel's public 3-tier
 * verdict: ALLOW | BLOCK | UNCERTAIN.
 *
 * Pure function. No I/O, no side effects.
 */

import { toPublicVerdict, type InternalVerdict } from 'pot-cli/verdict';
import type { SentinelVerdict } from '../types.js';

/**
 * Map pot-cli's internal verdict to Sentinel's public verdict.
 *
 * pot-cli emits: ALLOW | CONDITIONAL_ALLOW | HOLD | BLOCK | DISSENT
 * pot-cli's toPublicVerdict maps to: ALLOW | BLOCK | UNCERTAIN
 * Sentinel uses the same 3-tier: ALLOW | BLOCK | UNCERTAIN
 *
 * Direct pass-through — pot-cli already does the mapping we need.
 */
export function mapVerdict(internalVerdict: string): SentinelVerdict {
  const publicResponse = toPublicVerdict(internalVerdict as InternalVerdict);
  return publicResponse.verdict as SentinelVerdict;
}
