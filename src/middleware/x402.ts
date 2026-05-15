/**
 * x402 Payment Middleware for ThoughtProof Sentinel
 *
 * Lightweight implementation — NO heavy dependencies.
 * Uses the x402 Facilitator REST API instead of @circle-fin/x402-batching SDK.
 *
 * Three auth flows:
 *   Flow A (API key): X-Sentinel-Key present → skip payment
 *   Flow B1 (x402 Facilitator): PAYMENT-SIGNATURE header → verify + settle via HTTP API
 *   Flow B2 (manual intent): X-Payment-Intent header → Upstash Redis-backed flow
 *
 * Platform traffic (OpenServ, ACP) is billed post-hoc, not gated.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash, randomBytes } from 'crypto';
import { Redis } from '@upstash/redis';
import { TIER_CONFIGS } from '../tiers.js';
import type { SentinelTier, PaymentPlatform } from '../types.js';

// ── Config ────────────────────────────────────────────────────────────────

const PAYMENT_WALLET = process.env.PAYMENT_WALLET ?? '0xAB9f84864662f980614bD1453dB9950Ef2b82E83';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const INTENT_TTL_MS = 15 * 60 * 1000; // 15 min

// x402 Facilitator endpoint — Circle's hosted facilitator
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator';

// ── Redis (shared with rate limiting) ─────────────────────────────────────

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

// ── Pricing ───────────────────────────────────────────────────────────────

function resolvePrice(body: unknown): { price: string; tier: SentinelTier } {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const tier = (b.tier as SentinelTier) ?? 'standard';
  const config = TIER_CONFIGS[tier] ?? TIER_CONFIGS.standard;
  return { price: config.price_usd.toFixed(4).replace(/\.?0+$/, ''), tier };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function canonicalHash(route: string, body: unknown): string {
  const canonical = JSON.stringify({ route, body }, Object.keys({ route, body }).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

function generateNanoid(size = 16): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = randomBytes(size);
  let id = '';
  for (let i = 0; i < size; i++) {
    id += alphabet[bytes[i] % alphabet.length];
  }
  return id;
}

// Platforms that are billed post-hoc (not gated)
const PLATFORM_BYPASS: PaymentPlatform[] = ['openserv', 'acp'];

// ── Facilitator API (lightweight HTTP) ────────────────────────────────────

interface FacilitatorVerifyResult {
  isValid: boolean;
  invalidReason?: string;
}

interface FacilitatorSettleResult {
  success: boolean;
  txHash?: string;
  network?: string;
  error?: string;
}

/**
 * Verify a payment payload against requirements via the x402 Facilitator.
 * This replaces BatchFacilitatorClient.verify() with a simple fetch().
 */
async function facilitatorVerify(
  payload: unknown,
  paymentRequirements: unknown,
): Promise<FacilitatorVerifyResult> {
  const resp = await fetch(`${FACILITATOR_URL}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, paymentRequirements }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => 'unknown');
    return { isValid: false, invalidReason: `Facilitator verify failed (${resp.status}): ${text}` };
  }

  return await resp.json() as FacilitatorVerifyResult;
}

/**
 * Settle a payment via the x402 Facilitator.
 * This replaces BatchFacilitatorClient.settle() with a simple fetch().
 */
async function facilitatorSettle(
  payload: unknown,
  paymentRequirements: unknown,
): Promise<FacilitatorSettleResult> {
  const resp = await fetch(`${FACILITATOR_URL}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, paymentRequirements }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => 'unknown');
    return { success: false, error: `Facilitator settle failed (${resp.status}): ${text}` };
  }

  return await resp.json() as FacilitatorSettleResult;
}

// ── Main Gate ─────────────────────────────────────────────────────────────

export interface X402GateResult {
  /** true = request may proceed */
  allowed: boolean;
  /** If not allowed, the gate already sent the response */
  paymentMethod?: 'api-key' | 'x402-facilitator' | 'intent' | 'platform-bypass';
}

/**
 * x402 payment gate for Sentinel verify endpoint.
 *
 * Returns { allowed: true } if the request should proceed.
 * Returns { allowed: false } if the gate already sent a 402/4xx response.
 */
export async function x402Gate(req: VercelRequest, res: VercelResponse): Promise<X402GateResult> {
  // ── Skip if x402 is disabled ──────────────────────────────────────────
  if (process.env.SENTINEL_X402_ENABLED !== 'true') {
    return { allowed: true, paymentMethod: 'api-key' };
  }

  // ── Flow A: API key bypasses payment ──────────────────────────────────
  const apiKey = req.headers['x-sentinel-key'] as string | undefined;
  if (apiKey) {
    return { allowed: true, paymentMethod: 'api-key' };
  }

  // ── Platform bypass: OpenServ/ACP traffic is billed post-hoc ──────────
  const platform = req.headers['x-sentinel-platform'] as string | undefined;
  if (platform && PLATFORM_BYPASS.includes(platform as PaymentPlatform)) {
    return { allowed: true, paymentMethod: 'platform-bypass' };
  }

  // ── Flow B1: x402 Standard Payment (via Facilitator API) ──────────────
  const paymentSig = req.headers['payment-signature'] as string | undefined;
  if (paymentSig) {
    const { price } = resolvePrice(req.body);
    const amountMicro = Math.round(parseFloat(price) * 1_000_000).toString();

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(paymentSig, 'base64').toString());
    } catch {
      res.status(402).json({ error: 'Invalid PAYMENT-SIGNATURE header: not valid base64 JSON' });
      return { allowed: false };
    }

    const paymentRequirements = {
      scheme: 'exact',
      network: 'eip155:8453', // Base mainnet
      amount: amountMicro,
      asset: USDC_BASE,
      payTo: PAYMENT_WALLET,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    };

    // Step 1: Verify the payment is valid
    let verification: FacilitatorVerifyResult;
    try {
      verification = await facilitatorVerify(payload, paymentRequirements);
    } catch (err) {
      console.error('[x402] Facilitator verify error:', err);
      res.status(502).json({ error: `Payment verification unavailable: ${String(err)}` });
      return { allowed: false };
    }

    if (!verification.isValid) {
      res.status(402).json({
        error: 'Payment verification failed',
        reason: verification.invalidReason,
      });
      return { allowed: false };
    }

    // Step 2: Settle the payment
    let settlement: FacilitatorSettleResult;
    try {
      settlement = await facilitatorSettle(payload, paymentRequirements);
    } catch (err) {
      console.error('[x402] Facilitator settle error:', err);
      res.status(502).json({ error: `Settlement unavailable: ${String(err)}` });
      return { allowed: false };
    }

    if (!settlement.success) {
      res.status(402).json({
        error: 'Settlement failed',
        details: settlement.error,
      });
      return { allowed: false };
    }

    // Attach receipt header per x402 spec
    const receipt = {
      txHash: settlement.txHash,
      network: settlement.network ?? 'eip155:8453',
      paidWith: 'x402-facilitator',
    };
    res.setHeader('payment-response', Buffer.from(JSON.stringify(receipt)).toString('base64'));

    return { allowed: true, paymentMethod: 'x402-facilitator' };
  }

  // ── Flow B2: Manual payment intent ────────────────────────────────────
  const intentId = req.headers['x-payment-intent'] as string | undefined;

  if (!intentId) {
    // No payment at all → return 402 challenge
    const { price } = resolvePrice(req.body);
    const amountMicro = Math.round(parseFloat(price) * 1_000_000).toString();
    const now = Date.now();

    const intent = {
      id: `pi_${generateNanoid(16)}`,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + INTENT_TTL_MS).toISOString(),
      status: 'pending',
      route: req.url ?? '/sentinel/verify',
      amount_usdc: price,
      request_hash: canonicalHash(req.url ?? '/sentinel/verify', req.body ?? {}),
    };

    // Store in Redis with TTL
    const redis = getRedis();
    if (redis) {
      await redis.set(
        `sentinel:intent:${intent.id}`,
        JSON.stringify(intent),
        { ex: Math.ceil(INTENT_TTL_MS / 1000) },
      );
    }

    // x402 v2 challenge
    const x402Challenge = {
      x402Version: 2,
      error: 'Payment required',
      resource: {
        url: 'https://sentinel.thoughtproof.ai/sentinel/verify',
        description: 'Lightweight pre-execution verification for autonomous agent loops — ALLOW/BLOCK/UNCERTAIN',
        mimeType: 'application/json',
      },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: amountMicro,
          asset: USDC_BASE,
          payTo: PAYMENT_WALLET,
          maxTimeoutSeconds: 300,
          extra: { name: 'USD Coin', version: '2' },
        },
      ],
    };
    const x402Header = Buffer.from(JSON.stringify(x402Challenge)).toString('base64');

    res
      .setHeader('X-Payment-Intent', intent.id)
      .setHeader('payment-required', x402Header)
      .status(402)
      .json({
        error: 'Payment Required',
        protocol: 'x402',
        intentId: intent.id,
        payment: {
          amountUsdc: price,
          recipientWallet: PAYMENT_WALLET,
          tokenAddress: USDC_BASE,
          network: 'base',
          expiresAt: intent.expires_at,
        },
        instructions: [
          'Option A (x402): Send PAYMENT-SIGNATURE header with base64-encoded EIP-3009 payload',
          `Option B (manual): 1. Send ${price} USDC to ${PAYMENT_WALLET} on Base`,
          `2. Confirm payment at POST /sentinel/payment-intents/${intent.id}/confirm with { "txHash": "0x..." }`,
          `3. Retry this request with header X-Payment-Intent: ${intent.id}`,
        ],
      });
    return { allowed: false };
  }

  // Has intent → validate it from Redis
  const redis = getRedis();
  if (!redis) {
    res.status(500).json({ error: 'Payment intent storage unavailable', code: 'INTERNAL_ERROR' });
    return { allowed: false };
  }

  const raw = await redis.get<string>(`sentinel:intent:${intentId}`);
  if (!raw) {
    res.status(402).json({ error: 'Invalid or expired payment intent' });
    return { allowed: false };
  }

  const intent = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));

  if (new Date(intent.expires_at).getTime() < Date.now()) {
    await redis.del(`sentinel:intent:${intentId}`);
    res.status(410).json({ error: 'Payment intent expired' });
    return { allowed: false };
  }

  if (intent.status !== 'paid') {
    res.status(402).json({
      error: `Payment intent status is '${intent.status}', expected 'paid'`,
      intentId,
    });
    return { allowed: false };
  }

  // Check request hash
  const currentHash = canonicalHash(req.url ?? '/sentinel/verify', req.body ?? {});
  if (currentHash !== intent.request_hash) {
    res.status(400).json({ error: 'Request body does not match payment intent' });
    return { allowed: false };
  }

  // Mark as consumed
  await redis.del(`sentinel:intent:${intentId}`);

  return { allowed: true, paymentMethod: 'intent' };
}
