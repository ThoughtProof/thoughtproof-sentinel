import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getModelReadiness } from '../../src/model-config.js';
import { getPotCliVersion } from '../../src/runtime-versions.js';
import { getRateLimitReadiness } from '../../src/upstash-env.js';

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
    // Readiness comes from upstash-env (env probe only — no PING).
    // rate_limit "redis" means configured, not connectivity-checked.
    // Do not import auth / rate-limit-policy.json / @upstash/ratelimit
    // here — those crashed Preview health at load
    // (FUNCTION_INVOCATION_FAILED on c944f5b).
    const { ready: modelReady, serv_key } = getModelReadiness();
    const { rate_limit } = getRateLimitReadiness();
    // ADR-0021 hard variant: Production in-memory fallback is not ready.
    // Preview/dev may still report in_memory + ready (no Upstash vars).
    const prod = process.env.VERCEL_ENV === 'production';
    const ready =
      modelReady && rate_limit !== 'unavailable' && !(prod && rate_limit === 'in_memory');

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
