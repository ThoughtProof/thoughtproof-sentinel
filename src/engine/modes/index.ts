/**
 * Mode Router
 *
 * Maps SentinelMode to the appropriate handler. Pure dispatch, no I/O.
 */

import type { SentinelMode } from '../../types.js';
import type { ModeHandler } from './types.js';
import { handoff } from './handoff.js';
import { planRevision } from './plan_revision.js';
import { memoryWrite } from './memory_write.js';
import { outputSynthesis } from './output_synthesis.js';

export type { ModeHandler, ModeInput, ModeOutput } from './types.js';

const MODE_HANDLERS: Record<SentinelMode, ModeHandler> = {
  handoff,
  plan_revision: planRevision,
  memory_write: memoryWrite,
  output_synthesis: outputSynthesis,
};

export function getModeHandler(mode: SentinelMode): ModeHandler {
  const handler = MODE_HANDLERS[mode];
  if (!handler) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  return handler;
}
