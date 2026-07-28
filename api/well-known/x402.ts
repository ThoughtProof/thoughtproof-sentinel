/**
 * GET /.well-known/x402
 *
 * Machine-readable x402 catalog for XRPL AI Hub auto-listing.
 * Hub keys resources by URL — we advertise ONE verify resource with multiple
 * accepts (Base + XRPL checkpoint + XRPL standard) so both price tiers show.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { TIER_CONFIGS } from '../../src/tiers.js';
import { isGoatEnabled, getGoatConfig, GOAT_NETWORK } from '../../src/middleware/goat-x402.js';
import {
  isXrplEnabled,
  buildXrplRequirements,
  getXrplConfig,
  RLUSD_HEX,
} from '../../src/middleware/xrpl-x402.js';

const PAYMENT_WALLET = process.env.PAYMENT_WALLET ?? '0xAB9f84864662f980614bD1453dB9950Ef2b82E83';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RESOURCE_URL = 'https://sentinel.thoughtproof.ai/sentinel/verify';

function amountMicro(usd: string): string {
  return Math.round(parseFloat(usd) * 1_000_000).toString();
}

function xrplAccept(usdPrice: string, tier: string) {
  const reqs = buildXrplRequirements({
    usdPrice,
    invoiceId: `catalog-${tier}`,
    resource: RESOURCE_URL,
  });
  return {
    scheme: reqs.scheme,
    network: reqs.network,
    amount: reqs.amount,
    maxAmountRequired: reqs.amount,
    asset: reqs.asset,
    payTo: reqs.payTo,
    resource: RESOURCE_URL,
    maxTimeoutSeconds: reqs.maxTimeoutSeconds,
    extra: {
      ...reqs.extra,
      invoiceId: undefined,
      name: getXrplConfig().asset === 'XRP' ? 'XRP' : 'RLUSD',
      tier,
      note: 'Live 402 challenges mint a unique extra.invoiceId per request',
    },
  };
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (process.env.SENTINEL_X402_ENABLED !== 'true') {
    return res.status(404).json({ error: 'x402 not enabled on this deployment' });
  }

  const checkpointUsd = String(TIER_CONFIGS.checkpoint?.price_usd ?? 0.005);
  const standardUsd = String(TIER_CONFIGS.standard?.price_usd ?? 0.008);
  const microC = amountMicro(checkpointUsd);
  const microS = amountMicro(standardUsd);

  const accepts: Record<string, unknown>[] = [
    // Base USDC — checkpoint (default advertised unit)
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: microC,
      maxAmountRequired: microC,
      asset: USDC_BASE,
      payTo: PAYMENT_WALLET,
      resource: RESOURCE_URL,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2', tier: 'checkpoint' },
    },
    {
      scheme: 'exact',
      network: 'base',
      amount: microC,
      maxAmountRequired: microC,
      asset: USDC_BASE,
      payTo: PAYMENT_WALLET,
      resource: RESOURCE_URL,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2', tier: 'checkpoint' },
    },
    // Base USDC — standard
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: microS,
      maxAmountRequired: microS,
      asset: USDC_BASE,
      payTo: PAYMENT_WALLET,
      resource: RESOURCE_URL,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2', tier: 'standard' },
    },
  ];

  if (isGoatEnabled()) {
    accepts.push({
      scheme: 'exact',
      network: GOAT_NETWORK,
      amount: microC,
      maxAmountRequired: microC,
      asset: getGoatConfig().usdcAddress,
      payTo: getGoatConfig().paymentWallet,
      resource: RESOURCE_URL,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', gateway: 'goat-x402', tier: 'checkpoint' },
    });
  }

  if (isXrplEnabled()) {
    // Both tiers as separate XRPL accepts — hub lists price options under one resource URL
    accepts.push(xrplAccept(checkpointUsd, 'checkpoint'));
    accepts.push(xrplAccept(standardUsd, 'standard'));
  }

  const body = {
    name: 'ThoughtProof Sentinel',
    description:
      'Pre-execution verification for autonomous agents. Pay per check via x402; receive ALLOW / BLOCK / UNCERTAIN with structured objections. Checkpoint (sub-cent) and Standard tiers.',
    url: 'https://sentinel.thoughtproof.ai',
    x402Version: 2,
    resources: [
      {
        name: 'sentinel-verify',
        description:
          'Decision check before agent execution: ALLOW / BLOCK / UNCERTAIN + objections. Tiers: checkpoint (~$0.005) and standard (~$0.008). Same endpoint; price follows request tier.',
        url: RESOURCE_URL,
        mimeType: 'application/json',
        accepts,
      },
      // Explicit tier aliases (same URL) — some crawlers prefer named resources
      {
        name: 'sentinel-verify-checkpoint',
        description:
          'Checkpoint-tier decision check. Sub-cent, loop-safe. ALLOW/BLOCK/UNCERTAIN.',
        url: `${RESOURCE_URL}?tier=checkpoint`,
        mimeType: 'application/json',
        accepts: isXrplEnabled()
          ? [
              {
                scheme: 'exact',
                network: 'eip155:8453',
                amount: microC,
                maxAmountRequired: microC,
                asset: USDC_BASE,
                payTo: PAYMENT_WALLET,
                resource: RESOURCE_URL,
                maxTimeoutSeconds: 300,
                extra: { name: 'USD Coin', version: '2', tier: 'checkpoint' },
              },
              xrplAccept(checkpointUsd, 'checkpoint'),
            ]
          : [
              {
                scheme: 'exact',
                network: 'eip155:8453',
                amount: microC,
                maxAmountRequired: microC,
                asset: USDC_BASE,
                payTo: PAYMENT_WALLET,
                resource: RESOURCE_URL,
                maxTimeoutSeconds: 300,
                extra: { name: 'USD Coin', version: '2', tier: 'checkpoint' },
              },
            ],
      },
      {
        name: 'sentinel-verify-standard',
        description:
          'Standard-tier decision check with nano→swift cascade. ALLOW/BLOCK/UNCERTAIN.',
        url: `${RESOURCE_URL}?tier=standard`,
        mimeType: 'application/json',
        accepts: isXrplEnabled()
          ? [
              {
                scheme: 'exact',
                network: 'eip155:8453',
                amount: microS,
                maxAmountRequired: microS,
                asset: USDC_BASE,
                payTo: PAYMENT_WALLET,
                resource: RESOURCE_URL,
                maxTimeoutSeconds: 300,
                extra: { name: 'USD Coin', version: '2', tier: 'standard' },
              },
              xrplAccept(standardUsd, 'standard'),
            ]
          : [
              {
                scheme: 'exact',
                network: 'eip155:8453',
                amount: microS,
                maxAmountRequired: microS,
                asset: USDC_BASE,
                payTo: PAYMENT_WALLET,
                resource: RESOURCE_URL,
                maxTimeoutSeconds: 300,
                extra: { name: 'USD Coin', version: '2', tier: 'standard' },
              },
            ],
      },
    ],
    networks: {
      base: { caip2: 'eip155:8453', asset: 'USDC', facilitator: 'coinbase-cdp' },
      ...(isGoatEnabled()
        ? { goat: { caip2: GOAT_NETWORK, asset: 'USDC', facilitator: 'goat-x402' } }
        : {}),
      ...(isXrplEnabled()
        ? {
            xrpl: {
              caip2: getXrplConfig().network,
              asset: getXrplConfig().asset === 'XRP' ? 'XRP' : 'RLUSD',
              assetCode: getXrplConfig().asset,
              issuer: getXrplConfig().issuer || undefined,
              facilitator: getXrplConfig().facilitatorUrl,
              payTo: getXrplConfig().payTo,
            },
          }
        : {}),
    },
    meta: {
      rlusdHex: RLUSD_HEX,
      listing: 'https://xrpl-ai.org/join/service',
      docs: 'https://thoughtproof.ai',
      website: 'https://thoughtproof.ai',
    },
  };

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'HEAD') return res.status(200).end();
  return res.status(200).json(body);
}
