/**
 * POST /sentinel/payment-intents/:id/confirm
 *
 * Flow B2 step 2: Client sends { txHash: "0x..." } to confirm manual payment.
 * We store the txHash and mark the intent as 'paid' in Redis.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Extract intent ID from URL: /sentinel/payment-intents/pi_xxx/confirm
  const url = req.url ?? '';
  const match = url.match(/payment-intents\/(pi_[A-Za-z0-9_-]+)\/confirm/);
  if (!match) {
    return res.status(400).json({ error: 'Missing or invalid intent ID in URL' });
  }
  const intentId = match[1];

  const body = req.body as Record<string, unknown> | null;
  const txHash = body?.txHash;
  if (!txHash || typeof txHash !== 'string' || !txHash.startsWith('0x')) {
    return res.status(400).json({ error: 'Missing or invalid txHash (must start with 0x)' });
  }

  const redis = getRedis();
  if (!redis) {
    return res.status(500).json({ error: 'Payment intent storage unavailable' });
  }

  const raw = await redis.get<string>(`sentinel:intent:${intentId}`);
  if (!raw) {
    return res.status(404).json({ error: 'Payment intent not found or expired' });
  }

  const intent = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));

  if (intent.status !== 'pending') {
    return res.status(409).json({ error: `Intent status is '${intent.status}', expected 'pending'` });
  }

  if (new Date(intent.expires_at).getTime() < Date.now()) {
    await redis.del(`sentinel:intent:${intentId}`);
    return res.status(410).json({ error: 'Payment intent expired' });
  }

  // Mark as paid (we trust the txHash for now — chain verification is a future enhancement)
  intent.status = 'paid';
  intent.tx_hash = txHash;
  intent.paid_at = new Date().toISOString();

  // Re-store with remaining TTL
  const remainingMs = new Date(intent.expires_at).getTime() - Date.now();
  await redis.set(`sentinel:intent:${intentId}`, JSON.stringify(intent), {
    ex: Math.max(Math.ceil(remainingMs / 1000), 60),
  });

  console.log(JSON.stringify({
    event: 'sentinel_payment_intent_confirmed',
    intentId,
    txHash,
    amount_usdc: intent.amount_usdc,
    timestamp: new Date().toISOString(),
  }));

  return res.status(200).json({
    status: 'paid',
    intentId,
    txHash,
    message: 'Payment confirmed. Retry your verification request with header X-Payment-Intent: ' + intentId,
  });
}
