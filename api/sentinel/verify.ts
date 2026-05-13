import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateVerifyRequest } from '../../src/validation.js';
import { getTierConfig } from '../../src/tiers.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sentinel-Key');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', allowed: ['POST'] });
    }

    const contentType = req.headers['content-type'];
    if (contentType && !contentType.includes('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json', code: 'UNSUPPORTED_MEDIA_TYPE' });
    }

    const result = validateVerifyRequest(req.body);
    if (!result.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        code: 'INVALID_REQUEST',
        details: result.errors,
      });
    }

    const tierConfig = getTierConfig(result.data.tier);

    // Engine not yet wired — return 501 with useful info
    return res.status(501).json({
      error: 'Sentinel engine not yet implemented',
      code: 'ENGINE_NOT_IMPLEMENTED',
      hint: `Tier "${tierConfig.tier}" (${tierConfig.cascade.join('→')}) is configured but the verification engine is not yet wired.`,
      accepted_request: {
        mode: result.data.mode,
        tier: tierConfig.tier,
        cascade: tierConfig.cascade,
        price_usd: tierConfig.price_usd,
      },
    });
  } catch (error) {
    console.error('[sentinel/verify] error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}
