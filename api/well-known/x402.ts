/**
 * GET /.well-known/x402
 *
 * Machine-readable x402 catalog for discovery (XRPL AI Hub auto-listing,
 * Bazaar-style crawlers). Advertises paid resources with name + description
 * so listings don't show as "Registered Resource".
 *
 * XRPL accepts only appear when XRPL_PAY_TO is set (isXrplEnabled).
 * Base accepts always listed when x402 is enabled.
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

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (process.env.SENTINEL_X402_ENABLED !== 'true') {
    return res.status(404).json({ error: 'x402 not enabled on this deployment' });
  }

  // Catalog uses checkpoint tier as the advertised default unit price
  const checkpointUsd = String(TIER_CONFIGS.checkpoint?.price_usd ?? 0.005);
  const standardUsd = String(TIER_CONFIGS.standard?.price_usd ?? 0.008);
  const microC = amountMicro(checkpointUsd);
  const microS = amountMicro(standardUsd);

  const baseAccepts = [
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
  ];

  const goatAccepts = isGoatEnabled()
    ? [
        {
          scheme: 'exact',
          network: GOAT_NETWORK,
          amount: microC,
          maxAmountRequired: microC,
          asset: getGoatConfig().usdcAddress,
          payTo: getGoatConfig().paymentWallet,
          resource: RESOURCE_URL,
          maxTimeoutSeconds: 300,
          extra: { name: 'USD Coin', gateway: 'goat-x402', tier: 'checkpoint' },
        },
      ]
    : [];

  const xrplAccepts = isXrplEnabled()
    ? [
        (() => {
          const reqs = buildXrplRequirements({
            usdPrice: checkpointUsd,
            invoiceId: 'catalog', // catalog placeholder — live 402 issues real invoiceIds
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
              // catalog must not pin a single-use invoice
              invoiceId: undefined,
              name: getXrplConfig().asset === 'XRP' ? 'XRP' : 'RLUSD',
              tier: 'checkpoint',
              note: 'Live 402 challenges mint a unique extra.invoiceId per request',
            },
          };
        })(),
      ]
    : [];

  const body = {
    name: 'ThoughtProof Sentinel',
    description:
      'Pre-execution verification for autonomous agents. Pay per check via x402; receive ALLOW / BLOCK / UNCERTAIN with structured objections.',
    url: 'https://sentinel.thoughtproof.ai',
    x402Version: 2,
    resources: [
      {
        name: 'sentinel-verify-checkpoint',
        description:
          'Lightweight checkpoint-tier decision check (ALLOW/BLOCK/UNCERTAIN). Sub-cent, loop-safe.',
        url: RESOURCE_URL,
        mimeType: 'application/json',
        accepts: [...baseAccepts, ...goatAccepts, ...xrplAccepts],
      },
      {
        name: 'sentinel-verify-standard',
        description:
          'Standard-tier decision check with nano→swift cascade. Same verdict contract, deeper path.',
        url: RESOURCE_URL,
        mimeType: 'application/json',
        accepts: [
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
          ...(isXrplEnabled()
            ? [
                (() => {
                  const reqs = buildXrplRequirements({
                    usdPrice: standardUsd,
                    invoiceId: 'catalog-standard',
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
                      tier: 'standard',
                    },
                  };
                })(),
              ]
            : []),
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
    },
  };

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'HEAD') return res.status(200).end();
  return res.status(200).json(body);
}
