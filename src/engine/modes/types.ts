/**
 * Mode-Handler Interface
 *
 * Each mode shapes a Sentinel claim/evidence pair into pot-cli's EvalInput.
 * The mode handler defines WHAT is being verified, the cascade handles HOW.
 *
 * Mode handlers are pure functions — no I/O, no side effects, no imports
 * from adapters/. They transform semantics, not transport.
 */

import type { EvalInput, GoldStep } from 'pot-cli/plv';
import type { SentinelMode } from '../../types.js';
import type { AuthorizationMandate } from '../authorization-gate.js';
import type { ActionAuthTimelineModelMeta } from '../action-auth-timeline.js';

export interface ModeInput {
  id: string;
  claim: string;
  evidence: string;
  mode: SentinelMode;
  /** Optional machine-readable mandate (action_authorization only). */
  mandate?: AuthorizationMandate;
}

export interface ModeOutput {
  evalInput: EvalInput;
  evalMode: 'faithfulness' | 'support';
  /**
   * action_authorization only, and only when SENTINEL_AA_TIMELINE_CANONICAL
   * is on. Absent when the flag is off, so existing mode objects stay identical.
   */
  timeline?: ActionAuthTimelineModelMeta;
}

/**
 * A mode handler transforms Sentinel's claim/evidence into pot-cli's
 * question/answer/trace/plan_steps format.
 *
 * The mapping is mode-specific:
 * - handoff: claim = "agent output is coherent with handoff packet"
 * - plan_revision: claim = "revised plan still aligns with original goal"
 * - memory_write: claim = "summary faithfully represents source"
 * - output_synthesis: claim = "final output is supported by evidence chain"
 */
export type ModeHandler = (input: ModeInput) => ModeOutput;
