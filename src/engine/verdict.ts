/**
 * Verdict Mapper
 *
 * Maps pot-cli's internal verdict vocabulary to Sentinel's public 3-tier
 * verdict: ALLOW | BLOCK | UNCERTAIN.
 *
 * Pure function. No I/O, no side effects.
 */

import { toPublicVerdict, type InternalVerdict } from 'pot-cli/verdict';
import type { SentinelVerdict, SentinelMode } from '../types.js';

/**
 * Mode-specific verdict overrides.
 *
 * Some modes require stricter mapping than the default pot-cli behavior.
 * For example, trade_execution maps CONDITIONAL_ALLOW → UNCERTAIN because
 * "if in doubt, don't trade" is the correct default for capital-at-risk.
 */
const CONSERVATIVE_MODES: Set<SentinelMode> = new Set<SentinelMode>(['trade_execution']);

/**
 * Map pot-cli's internal verdict to Sentinel's public verdict.
 *
 * pot-cli emits: ALLOW | CONDITIONAL_ALLOW | HOLD | BLOCK | DISSENT
 *
 * Default mapping (via pot-cli's toPublicVerdict):
 *   ALLOW / CONDITIONAL_ALLOW → ALLOW
 *   HOLD / DISSENT → UNCERTAIN
 *   BLOCK → BLOCK
 *
 * Conservative modes (trade_execution):
 *   ALLOW → ALLOW
 *   CONDITIONAL_ALLOW → UNCERTAIN  (stricter: doubt = don't execute)
 *   HOLD / DISSENT → UNCERTAIN
 *   BLOCK → BLOCK
 */
export function mapVerdict(internalVerdict: string, mode?: SentinelMode): SentinelVerdict {
  // Conservative modes: CONDITIONAL_ALLOW → UNCERTAIN
  if (mode && CONSERVATIVE_MODES.has(mode) && internalVerdict === 'CONDITIONAL_ALLOW') {
    return 'UNCERTAIN';
  }

  const publicResponse = toPublicVerdict(internalVerdict as InternalVerdict);
  return publicResponse.verdict as SentinelVerdict;
}
