/**
 * x402 Payment Middleware for ThoughtProof Sentinel
 *
 * Lightweight implementation — NO heavy dependencies.
 * Supports three payment networks:
 *   - Base mainnet (eip155:8453) via Coinbase CDP Facilitator (default)
 *   - GOAT Network (eip155:2345) via GOAT x402 Merchant Gateway (opt-in, ENV-gated)
 *   - XRPL (xrpl:0 / xrpl:1) via t54 hosted facilitator (opt-in, ENV-gated)
 *
 * Four auth flows:
 *   Flow A  (API key):  X-Sentinel-Key present → skip payment
 *   Flow B1a (Base):    PAYMENT-SIGNATURE + Base network → CDP facilitator verify/settle
 *   Flow B1b (GOAT):    PAYMENT-SIGNATURE + GOAT network → GOAT gateway verify/settle
 *   Flow B1c (XRPL):    PAYMENT-SIGNATURE + xrpl:* network → t54 facilitator verify/settle
 *   Flow B2  (intent):  X-Payment-Intent header → Upstash Redis-backed manual flow
 *
 * Platform traffic (OpenServ, ACP) is billed post-hoc, not gated.
 *
 * GOAT ENV (all required for GOAT activation):
 *   GOAT_X402_API_KEY       — Merchant API key from GOAT x402 onboarding
 *   GOAT_X402_API_SECRET    — Merchant API secret for HMAC signing
 *   GOAT_USDC_ADDRESS       — USDC contract address on GOAT mainnet (eip155:2345)
 *   GOAT_X402_BASE_URL      — Gateway URL (default: https://api.goatx402.com)
 *   GOAT_X402_PAYMENT_WALLET — Payment wallet on GOAT (default: PAYMENT_WALLET)
 *
 * XRPL ENV (required for XRPL activation):
 *   XRPL_PAY_TO             — classic address (r…) receiving XRP/RLUSD
 *   XRPL_FACILITATOR_URL    — default https://xrpl-facilitator-mainnet.t54.ai
 *   XRPL_NETWORK            — default xrpl:0 (mainnet)
 *   XRPL_ASSET              — default RLUSD hex; or "XRP"
 *   XRPL_RLUSD_ISSUER       — default Ripple mainnet issuer
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash, randomBytes } from 'crypto';
import { Redis } from '@upstash/redis';
import { TIER_CONFIGS } from '../tiers.js';
import type { SentinelTier, PaymentPlatform } from '../types.js';
import { buildBazaarExtensions } from './bazaar-extension.js';
import {
  GOAT_NETWORK,
  isGoatEnabled,
  getGoatConfig,
  goatVerifyPayment,
  goatSettlePayment,
} from './goat-x402.js';
import {
  isXrplEnabled,
  isXrplNetwork,
  newXrplInvoiceId,
  buildXrplRequirements,
  xrplVerifyPayment,
  xrplSettlePayment,
  getXrplConfig,
} from './xrpl-x402.js';
import { generateCdpJwt, hasCdpCredentials } from './cdp-jwt.js';

// ── Config ────────────────────────────────────────────────────────────────

const PAYMENT_WALLET = process.env.PAYMENT_WALLET ?? '0xAB9f84864662f980614bD1453dB9950Ef2b82E83';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const INTENT_TTL_MS = 15 * 60 * 1000; // 15 min

// x402 Facilitator endpoint.
// Default (with CDP credentials): Coinbase CDP hosted facilitator — supports
// Base MAINNET (x402.org dropped mainnet "exact" from its registry, 2026-07).
// CDP ENV (both required to enable CDP mode):
//   X402_CDP_KEY_ID     — CDP API key id (UUID)
//   X402_CDP_KEY_SECRET — CDP API key secret (base64 Ed25519 keypair)
const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ??
  (hasCdpCredentials() ? CDP_FACILITATOR_URL : 'https://x402.org/facilitator');

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

function resolvePrice(
  body: unknown,
  query?: Record<string, string | string[] | undefined>,
): { price: string; tier: SentinelTier } {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const qTier = query?.tier;
  const fromQuery = Array.isArray(qTier) ? qTier[0] : qTier;
  const tier = (b.tier as SentinelTier) ?? (fromQuery as SentinelTier) ?? 'checkpoint';
  const config = TIER_CONFIGS[tier] ?? TIER_CONFIGS.checkpoint ?? TIER_CONFIGS.standard;
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
 * Build headers + URL for a facilitator call. CDP hosts require a Bearer JWT
 * signed with the CDP API key (EdDSA), with uri claim matching host+path.
 */
function facilitatorRequest(path: '/verify' | '/settle'): { url: string; headers: Record<string, string> } {
  const url = `${FACILITATOR_URL}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (hasCdpCredentials()) {
    const { host, pathname } = new URL(url);
    headers['Authorization'] =
      `Bearer ${generateCdpJwt(process.env.X402_CDP_KEY_ID!, process.env.X402_CDP_KEY_SECRET!, 'POST', host, pathname)}`;
  }
  return { url, headers };
}

/**
 * Transform a client payload (v1: { scheme, network, payload: {signature, authorization} })
 * into the CDP v2 shape: { x402Version: 2, accepted, payload, resource }.
 * Verified live 2026-07-26: CDP accepts this shape and runs on-chain signature checks.
 */
function toV2PaymentPayload(
  payload: Record<string, unknown>,
  paymentRequirements: Record<string, unknown>,
): Record<string, unknown> {
  return {
    x402Version: 2,
    accepted: paymentRequirements,
    payload: payload.payload ?? {},
    resource: {
      url: 'https://sentinel.thoughtproof.ai/sentinel/verify',
      description: 'ThoughtProof Sentinel decision verification',
      mimeType: 'application/json',
    },
  };
}

/** CDP v2 requirements: amount only (no maxAmountRequired), CAIP-2 network, no resource field. */
function toV2Requirements(req: Record<string, unknown>): Record<string, unknown> {
  return {
    scheme: req.scheme,
    network: 'eip155:8453',
    asset: req.asset,
    amount: req.amount,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    extra: req.extra,
  };
}

/**
 * Verify a payment payload against requirements via the x402 Facilitator.
 * This replaces BatchFacilitatorClient.verify() with a simple fetch().
 *
 * FIX 2026-07-26: facilitator expects { x402Version, paymentPayload, paymentRequirements } —
 * the previous shape { payload, ... } was rejected with "missing_parameters" on every call.
 * CDP mode additionally requires the v2 payload shape (accepted/payload/resource).
 */
async function facilitatorVerify(
  payload: unknown,
  paymentRequirements: unknown,
): Promise<FacilitatorVerifyResult> {
  const cdp = hasCdpCredentials();
  const req = paymentRequirements as Record<string, unknown>;
  const body = cdp
    ? { x402Version: 2, paymentPayload: toV2PaymentPayload(payload as Record<string, unknown>, toV2Requirements(req)), paymentRequirements: toV2Requirements(req) }
    : { x402Version: 1, paymentPayload: payload, paymentRequirements };
  const { url, headers } = facilitatorRequest('/verify');
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
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
 * CDP settle returns { success, transaction, network, errorReason, errorMessage } —
 * mapped here to the internal { txHash, error } shape.
 */
async function facilitatorSettle(
  payload: unknown,
  paymentRequirements: unknown,
): Promise<FacilitatorSettleResult> {
  const cdp = hasCdpCredentials();
  const req = paymentRequirements as Record<string, unknown>;
  const body = cdp
    ? { x402Version: 2, paymentPayload: toV2PaymentPayload(payload as Record<string, unknown>, toV2Requirements(req)), paymentRequirements: toV2Requirements(req) }
    : { x402Version: 1, paymentPayload: payload, paymentRequirements };
  const { url, headers } = facilitatorRequest('/settle');
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => 'unknown');
    return { success: false, error: `Facilitator settle failed (${resp.status}): ${text}` };
  }

  const raw = await resp.json() as Record<string, unknown>;
  return {
    success: raw.success === true,
    txHash: (raw.transaction ?? raw.txHash) as string | undefined,
    network: raw.network as string | undefined,
    error: (raw.error ?? raw.errorReason ?? raw.errorMessage) as string | undefined,
  };
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
    const { price } = resolvePrice(req.body, req.query as Record<string, string | string[] | undefined>);
    const amountMicro = Math.round(parseFloat(price) * 1_000_000).toString();

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(paymentSig, 'base64').toString());
    } catch {
      res.status(402).json({ error: 'Invalid PAYMENT-SIGNATURE header: not valid base64 JSON' });
      return { allowed: false };
    }

    // Detect which network the payment targets
    // SECURITY: Network field MUST explicitly declare GOAT / XRPL — payload alone is NOT enough
    const payloadNetwork = (payload.network as string) ?? '';
    // v2 payloads nest network under accepted.network
    const acceptedNet =
      payload.accepted && typeof payload.accepted === 'object'
        ? String((payload.accepted as Record<string, unknown>).network ?? '')
        : '';
    const effectiveNetwork = payloadNetwork || acceptedNet;

    const isGoatPayment =
      (effectiveNetwork === GOAT_NETWORK || effectiveNetwork === `eip155:${2345}`) &&
      isGoatEnabled();

    if (isGoatPayment) {
      // ── GOAT Network x402 flow ────────────────────────────────────────
      let verification = await goatVerifyPayment(payload);
      if (!verification.isValid) {
        res.status(402).json({
          error: 'GOAT payment verification failed',
          reason: verification.invalidReason,
        });
        return { allowed: false };
      }

      let settlement = await goatSettlePayment(payload);
      if (!settlement.success) {
        res.status(402).json({
          error: 'GOAT settlement failed',
          details: settlement.error,
        });
        return { allowed: false };
      }

      const receipt = {
        txHash: settlement.txHash,
        orderId: settlement.orderId,
        network: GOAT_NETWORK,
        paidWith: 'x402-goat',
      };
      res.setHeader('payment-response', Buffer.from(JSON.stringify(receipt)).toString('base64'));

      return { allowed: true, paymentMethod: 'x402-facilitator' };
    }

    // ── XRPL x402 flow (t54 facilitator) ────────────────────────────────
    if (isXrplNetwork(effectiveNetwork) && isXrplEnabled()) {
      let invoiceId = newXrplInvoiceId();
      if (payload.payload && typeof payload.payload === 'object') {
        const pid = (payload.payload as Record<string, unknown>).invoiceId;
        if (typeof pid === 'string' && pid.length > 0) invoiceId = pid;
      } else if (payload.accepted && typeof payload.accepted === 'object') {
        const extra = (payload.accepted as Record<string, unknown>).extra;
        if (extra && typeof extra === 'object') {
          const iid = (extra as Record<string, unknown>).invoiceId;
          if (typeof iid === 'string' && iid.length > 0) invoiceId = iid;
        }
      }

      let requirements;
      try {
        requirements = buildXrplRequirements({
          usdPrice: price,
          invoiceId,
          resource: 'https://sentinel.thoughtproof.ai/sentinel/verify',
        });
        // Prefer client-accepted amount/network if they match our rail
        if (payload.accepted && typeof payload.accepted === 'object') {
          const acc = payload.accepted as Record<string, unknown>;
          if (isXrplNetwork(String(acc.network ?? '')) && acc.amount != null) {
            requirements = {
              ...requirements,
              network: String(acc.network),
              amount: String(acc.amount),
              maxAmountRequired: String(acc.amount),
              asset: String(acc.asset ?? requirements.asset),
              payTo: String(acc.payTo ?? requirements.payTo),
              extra: {
                ...requirements.extra,
                ...((acc.extra as object) ?? {}),
                invoiceId:
                  (acc.extra as any)?.invoiceId ?? requirements.extra.invoiceId,
              },
            };
          }
        }
      } catch (err) {
        res.status(502).json({ error: `XRPL payment config error: ${String(err)}` });
        return { allowed: false };
      }

      let verification;
      try {
        verification = await xrplVerifyPayment(payload, requirements);
      } catch (err) {
        console.error('[x402] XRPL facilitator verify error:', err);
        res.status(502).json({ error: `XRPL payment verification unavailable: ${String(err)}` });
        return { allowed: false };
      }
      if (!verification.isValid) {
        res.status(402).json({
          error: 'XRPL payment verification failed',
          reason: verification.invalidReason,
        });
        return { allowed: false };
      }

      let settlement;
      try {
        settlement = await xrplSettlePayment(payload, requirements);
      } catch (err) {
        console.error('[x402] XRPL facilitator settle error:', err);
        res.status(502).json({ error: `XRPL settlement unavailable: ${String(err)}` });
        return { allowed: false };
      }
      if (!settlement.success) {
        res.status(402).json({
          error: 'XRPL settlement failed',
          details: settlement.error,
        });
        return { allowed: false };
      }

      const receipt = {
        txHash: settlement.txHash,
        network: settlement.network ?? requirements.network,
        paidWith: 'x402-xrpl',
        payer: settlement.payer ?? verification.payer,
      };
      res.setHeader('payment-response', Buffer.from(JSON.stringify(receipt)).toString('base64'));
      return { allowed: true, paymentMethod: 'x402-facilitator' };
    }

    // ── Base/CDP x402 flow (default) ────────────────────────────────────
    // Echo back the network token the client actually used ("base" or
    // "eip155:8453") so the facilitator's network match succeeds either way.
    // Default to CAIP-2 form when the payload omits it.
    // Reject unknown networks that aren't Base (don't silently send XRPL sigs to CDP).
    if (effectiveNetwork && isXrplNetwork(effectiveNetwork) && !isXrplEnabled()) {
      res.status(402).json({
        error: 'XRPL payments not enabled on this deployment',
        hint: 'Set XRPL_PAY_TO to enable xrpl:* accepts',
      });
      return { allowed: false };
    }
    const clientNetwork =
      effectiveNetwork === 'base' ? 'base' : 'eip155:8453';
    const paymentRequirements = {
      scheme: 'exact',
      network: clientNetwork,
      amount: amountMicro,
      maxAmountRequired: amountMicro,
      asset: USDC_BASE,
      payTo: PAYMENT_WALLET,
      resource: 'https://sentinel.thoughtproof.ai/sentinel/verify',
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
    const { price } = resolvePrice(req.body, req.query as Record<string, string | string[] | undefined>);
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
    // Dual network tokens on accepts: keep both eip155:8453 (CAIP-2) and legacy
    // "base" for facilitators/clients that string-match. Catalog (well-known) is
    // CAIP-2-only for AgentCash. Bazaar extension is additive for discovery.
    const x402Challenge = {
      x402Version: 2,
      error: 'Payment required',
      resource: {
        url: 'https://sentinel.thoughtproof.ai/sentinel/verify',
        description: 'Lightweight pre-execution verification for autonomous agent loops — ALLOW/BLOCK/UNCERTAIN',
        mimeType: 'application/json',
      },
      // CDP/AgentCash v2 Bazaar: info (examples) + schema validating info shape.
      extensions: buildBazaarExtensions(),
      accepts: [
        // Option 1: USDC on Base mainnet — CAIP-2 form (current x402 spec, docs.x402.org)
        {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: amountMicro,
          maxAmountRequired: amountMicro,
          asset: USDC_BASE,
          payTo: PAYMENT_WALLET,
          resource: 'https://sentinel.thoughtproof.ai/sentinel/verify',
          maxTimeoutSeconds: 300,
          extra: { name: 'USD Coin', version: '2' },
        },
        // Option 1b: USDC on Base mainnet — legacy string token form.
        // Many production x402 clients (x402scan, AgentCash, Coinbase's original
        // facilitator) match literally on network === "base" and cannot construct
        // a payment payload from the CAIP-2 URN. Advertise both so neither breaks.
        {
          scheme: 'exact',
          network: 'base',
          amount: amountMicro,
          maxAmountRequired: amountMicro,
          asset: USDC_BASE,
          payTo: PAYMENT_WALLET,
          resource: 'https://sentinel.thoughtproof.ai/sentinel/verify',
          maxTimeoutSeconds: 300,
          extra: { name: 'USD Coin', version: '2' },
        },
        // Option 2: USDC on GOAT Network (GOAT x402 gateway) — when configured
        ...(isGoatEnabled()
          ? [
              {
                scheme: 'exact',
                network: GOAT_NETWORK,
                amount: amountMicro,
                maxAmountRequired: amountMicro,
                asset: getGoatConfig().usdcAddress,
                payTo: getGoatConfig().paymentWallet,
                resource: 'https://sentinel.thoughtproof.ai/sentinel/verify',
                maxTimeoutSeconds: 300,
                extra: { name: 'USD Coin', gateway: 'goat-x402' },
              },
            ]
          : []),
        // Option 3: XRPL (t54 facilitator) — RLUSD 1:1 USD or XRP drops — when configured
        ...(isXrplEnabled()
          ? (() => {
              const invoiceId = newXrplInvoiceId();
              const req = buildXrplRequirements({
                usdPrice: price,
                invoiceId,
                resource: 'https://sentinel.thoughtproof.ai/sentinel/verify',
              });
              return [
                {
                  scheme: req.scheme,
                  network: req.network,
                  amount: req.amount,
                  maxAmountRequired: req.amount,
                  asset: req.asset,
                  payTo: req.payTo,
                  resource: req.resource,
                  maxTimeoutSeconds: req.maxTimeoutSeconds,
                  extra: req.extra,
                },
              ];
            })()
          : []),
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
        // Mirror challenge body fields some discovery tools parse from JSON
        // (not only the payment-required header). Additive; dual network stays.
        x402Version: 2,
        accepts: x402Challenge.accepts,
        resource: x402Challenge.resource,
        extensions: x402Challenge.extensions,
        payment: {
          amountUsdc: price,
          recipientWallet: PAYMENT_WALLET,
          tokenAddress: USDC_BASE,
          network: 'base',
          expiresAt: intent.expires_at,
        },
        instructions: [
          'Option A (x402): Send PAYMENT-SIGNATURE header with base64-encoded payment payload',
          `Option B (Base): Send ${price} USDC to ${PAYMENT_WALLET} on Base (eip155:8453)`,
          ...(isGoatEnabled()
            ? [`Option C (GOAT): Pay via GOAT x402 gateway (eip155:2345) — include orderId in payload`]
            : []),
          ...(isXrplEnabled()
            ? [
                `Option D (XRPL): Pay via x402 on ${getXrplConfig().network} (${getXrplConfig().asset === 'XRP' ? 'XRP' : 'RLUSD'}) to ${getXrplConfig().payTo}`,
              ]
            : []),
          `Confirm payment: POST /sentinel/payment-intents/${intent.id}/confirm with { "txHash": "0x..." }`,
          `Retry with header X-Payment-Intent: ${intent.id}`,
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
