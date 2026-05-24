import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  res.status(200).json({
    name: 'ThoughtProof Sentinel',
    description: 'Pre-execution checkpoint for AI agents. Verify reasoning before irreversible actions.',
    version: '0.1.0',
    docs: 'https://thoughtproof.ai',
    endpoints: {
      health: '/sentinel/health',
      verify: '/sentinel/verify',
      tiers: '/sentinel/tiers',
    },
    auth: 'X-API-Key or x402 micropayment (USDC on Base)',
  });
}
