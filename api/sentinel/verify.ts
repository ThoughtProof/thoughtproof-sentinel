import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateVerifyRequest } from '../../src/validation.js';
import { getTierConfig } from '../../src/tiers.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', allowed: ['POST'] });
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
    hint: `Tier "${tierConfig.tier}" (${tierConfig.cascade.join('→')}) is configured but the verification engine is not yet wired. This endpoint will return real verdicts once the engine is connected.`,
    accepted_request: {
      mode: result.data.mode,
      tier: tierConfig.tier,
      cascade: tierConfig.cascade,
      price_usd: tierConfig.price_usd,
    },
  });
}
