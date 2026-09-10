import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getModelReadiness } from '../../src/model-config.js';
import { getPotCliVersion } from '../../src/runtime-versions.js';

const VERSION = '0.1.0';
const MODES = ['handoff', 'plan_revision', 'memory_write', 'output_synthesis', 'trade_execution', 'trade_reasoning', 'action_authorization'] as const;
const TIERS = ['checkpoint', 'standard'] as const;

export default function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sentinel-Key');

    if (_req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    // ok = liveness. ready / serv_key = cascade readiness (issue #32).
    // Presence only — never the key value.
    const { ready, serv_key } = getModelReadiness();

    res.status(200).json({
      ok: true,
      ready,
      serv_key,
      version: VERSION,
      pot_cli: getPotCliVersion(),
      modes: [...MODES],
      tiers: [...TIERS],
    });
  } catch (error) {
    console.error('[sentinel/health] error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}
