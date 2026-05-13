import type { VercelRequest, VercelResponse } from '@vercel/node';

const VERSION = '0.1.0';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    ok: true,
    version: VERSION,
    modes: ['handoff', 'plan_revision', 'memory_write', 'output_synthesis'],
    tiers: ['checkpoint', 'standard'],
  });
}
