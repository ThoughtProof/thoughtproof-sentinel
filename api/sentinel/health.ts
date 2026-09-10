import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRateLimitReadiness } from '../../src/auth.js';
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

    // ok = liveness only (issue #32 / #40).
    // ready = cascade (serv_key) AND limiter store. Fail-closed Redis
    // (configured-but-invalid) makes ready false so health matches verify 503.
    // serv_key presence only — never the key value.
    const { ready: modelReady, serv_key } = getModelReadiness();
    const { rate_limit } = getRateLimitReadiness();
    const ready = modelReady && rate_limit !== 'unavailable';

    res.status(200).json({
      ok: true,
      ready,
      serv_key,
      rate_limit,
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
