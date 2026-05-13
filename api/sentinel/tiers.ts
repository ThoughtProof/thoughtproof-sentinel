import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listTiers } from '../../src/tiers.js';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  const tiers = listTiers();
  res.status(200).json({
    tiers,
    default_tier: 'standard',
    count: tiers.length,
  });
}
