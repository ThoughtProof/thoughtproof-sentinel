import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listTiers } from '../../src/tiers.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sentinel-Key');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    const tiers = listTiers();
    res.status(200).json({
      tiers,
      default_tier: 'standard',
      count: tiers.length,
    });
  } catch (error) {
    console.error('[sentinel/tiers] error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}
