/**
 * GET /.well-known/thoughtproof-keys.json
 *
 * Public keys for verifying ThoughtProof Sentinel M1 signed canonical exports.
 * Static import so Vercel always bundles data/ into this function.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import keysDoc from '../../data/thoughtproof-keys.json' with { type: 'json' };

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const body = JSON.stringify(keysDoc);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'HEAD') return res.status(200).end();
    return res.status(200).send(body);
  } catch {
    return res.status(500).json({ error: 'thoughtproof_keys_unavailable' });
  }
}
