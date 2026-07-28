/**
 * XRPL x402 Facilitator Client (t54 hosted)
 *
 * Parallel rail to Base/CDP and GOAT. ENV-gated — Base path is unchanged when
 * XRPL is off. No API keys / no custody on the facilitator side.
 *
 * ENV (all required to enable XRPL accepts + settlement):
 *   XRPL_PAY_TO              — classic address receiving funds (r…)
 *   XRPL_FACILITATOR_URL     — default mainnet hosted facilitator
 *   XRPL_NETWORK             — CAIP-2, default xrpl:0 (mainnet)
 *   XRPL_ASSET               — "XRP" or RLUSD hex code (default RLUSD mainnet)
 *   XRPL_RLUSD_ISSUER        — required when asset is RLUSD (default Ripple mainnet issuer)
 *   XRPL_SOURCE_TAG          — optional SourceTag (default 804681468 per x402-xrpl SDK)
 *
 * Facilitator body (x402-xrpl SDK): { paymentPayload, paymentRequirements }
 * — no JWT, no x402Version top-level (unlike CDP).
 */

import { createHash, randomBytes } from 'crypto';

/** Ripple RLUSD on XRPL mainnet — 40-hex currency code */
export const RLUSD_HEX = '524C555344000000000000000000000000000000';
/** Ripple RLUSD issuer (mainnet) — verified via account_lines currency field */
export const RLUSD_ISSUER_MAINNET = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

const DEFAULT_FACILITATOR_MAINNET = 'https://xrpl-facilitator-mainnet.t54.ai';
const DEFAULT_FACILITATOR_TESTNET = 'https://xrpl-facilitator-testnet.t54.ai';
const DEFAULT_SOURCE_TAG = 804681468;

export function getXrplConfig() {
  const network = (process.env.XRPL_NETWORK ?? 'xrpl:0').trim();
  const defaultFacilitator =
    network === 'xrpl:1' ? DEFAULT_FACILITATOR_TESTNET : DEFAULT_FACILITATOR_MAINNET;
  const asset = (process.env.XRPL_ASSET ?? RLUSD_HEX).trim();
  const issuer =
    process.env.XRPL_RLUSD_ISSUER?.trim() ||
    (asset === RLUSD_HEX || asset === 'RLUSD' ? RLUSD_ISSUER_MAINNET : '');
  const sourceTagRaw = process.env.XRPL_SOURCE_TAG;
  const sourceTag =
    sourceTagRaw != null && sourceTagRaw !== ''
      ? Number(sourceTagRaw)
      : DEFAULT_SOURCE_TAG;

  return {
    payTo: process.env.XRPL_PAY_TO?.trim() ?? '',
    facilitatorUrl: (process.env.XRPL_FACILITATOR_URL ?? defaultFacilitator).replace(/\/+$/, ''),
    network,
    asset: asset === 'RLUSD' ? RLUSD_HEX : asset,
    issuer,
    sourceTag: Number.isFinite(sourceTag) ? sourceTag : DEFAULT_SOURCE_TAG,
  };
}

/** XRPL rail is on only when we have a classic receive address. */
export function isXrplEnabled(): boolean {
  const cfg = getXrplConfig();
  if (!cfg.payTo || !cfg.payTo.startsWith('r') || cfg.payTo.length < 25) return false;
  if (!cfg.network.startsWith('xrpl:')) return false;
  // IOU (non-XRP) needs issuer
  if (cfg.asset !== 'XRP' && !cfg.issuer) return false;
  return true;
}

export function isXrplNetwork(network: string | undefined): boolean {
  if (!network) return false;
  return network === 'xrpl' || network.startsWith('xrpl:');
}

export function newXrplInvoiceId(): string {
  return `tp_xrpl_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
}

/**
 * USD price string (e.g. "0.005") → XRPL amount string.
 * RLUSD/IOU: pass through as decimal string (1:1 USD).
 * XRP: convert via XRPL_XRP_USD (default 0.5) into drops (integer string).
 */
export function usdPriceToXrplAmount(usdPrice: string): string {
  const cfg = getXrplConfig();
  const usd = Number(usdPrice);
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(`Invalid USD price for XRPL amount: ${usdPrice}`);
  }
  if (cfg.asset === 'XRP') {
    const xrpUsd = Number(process.env.XRPL_XRP_USD ?? '0.5');
    const xrp = usd / (Number.isFinite(xrpUsd) && xrpUsd > 0 ? xrpUsd : 0.5);
    const drops = Math.max(1, Math.round(xrp * 1_000_000));
    return String(drops);
  }
  // IOU / RLUSD — avoid scientific notation; keep reasonable precision
  return usd.toFixed(6).replace(/\.?0+$/, '') || '0';
}

export type XrplPaymentRequirements = {
  scheme: 'exact';
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  resource?: string;
  maxAmountRequired?: string;
  extra: {
    invoiceId: string;
    sourceTag: number;
    issuer?: string;
    name?: string;
  };
};

export function buildXrplRequirements(params: {
  usdPrice: string;
  invoiceId: string;
  resource?: string;
  maxTimeoutSeconds?: number;
}): XrplPaymentRequirements {
  const cfg = getXrplConfig();
  if (!isXrplEnabled()) {
    throw new Error('XRPL x402 not enabled (set XRPL_PAY_TO)');
  }
  const amount = usdPriceToXrplAmount(params.usdPrice);
  const extra: XrplPaymentRequirements['extra'] = {
    invoiceId: params.invoiceId,
    sourceTag: cfg.sourceTag,
    name: cfg.asset === 'XRP' ? 'XRP' : 'RLUSD',
  };
  if (cfg.asset !== 'XRP' && cfg.issuer) {
    extra.issuer = cfg.issuer;
  }
  return {
    scheme: 'exact',
    network: cfg.network,
    amount,
    maxAmountRequired: amount,
    asset: cfg.asset,
    payTo: cfg.payTo,
    maxTimeoutSeconds: params.maxTimeoutSeconds ?? 600,
    resource: params.resource ?? 'https://sentinel.thoughtproof.ai/sentinel/verify',
    extra,
  };
}

export type XrplVerifyResult = {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
};

export type XrplSettleResult = {
  success: boolean;
  txHash?: string;
  network?: string;
  payer?: string;
  error?: string;
};

/**
 * Normalize client PAYMENT-SIGNATURE JSON into facilitator paymentPayload.
 * Accepts v2 ({x402Version, accepted, payload}) or loose shapes.
 */
export function toXrplPaymentPayload(
  clientPayload: Record<string, unknown>,
  requirements: XrplPaymentRequirements,
): Record<string, unknown> {
  // Already v2 with accepted
  if (clientPayload.accepted && clientPayload.payload) {
    return {
      x402Version: Number(clientPayload.x402Version ?? 2),
      accepted: clientPayload.accepted,
      payload: clientPayload.payload,
      resource: clientPayload.resource ?? {
        url: requirements.resource,
        description: 'ThoughtProof Sentinel verification',
        mimeType: 'application/json',
      },
      ...(clientPayload.extensions ? { extensions: clientPayload.extensions } : {}),
    };
  }
  // v1-ish: { scheme, network, payload }
  if (clientPayload.payload) {
    return {
      x402Version: 2,
      accepted: {
        scheme: requirements.scheme,
        network: requirements.network,
        amount: requirements.amount,
        asset: requirements.asset,
        payTo: requirements.payTo,
        maxTimeoutSeconds: requirements.maxTimeoutSeconds,
        extra: requirements.extra,
      },
      payload: clientPayload.payload,
      resource: {
        url: requirements.resource,
        description: 'ThoughtProof Sentinel verification',
        mimeType: 'application/json',
      },
    };
  }
  // Entire body might already be the inner payload (signedTxBlob)
  return {
    x402Version: 2,
    accepted: {
      scheme: requirements.scheme,
      network: requirements.network,
      amount: requirements.amount,
      asset: requirements.asset,
      payTo: requirements.payTo,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds,
      extra: requirements.extra,
    },
    payload: clientPayload,
    resource: {
      url: requirements.resource,
      description: 'ThoughtProof Sentinel verification',
      mimeType: 'application/json',
    },
  };
}

async function facilitatorPost(
  path: '/verify' | '/settle',
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const cfg = getXrplConfig();
  const url = `${cfg.facilitatorUrl}${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { ok: resp.ok, status: resp.status, json };
}

export async function xrplVerifyPayment(
  clientPayload: Record<string, unknown>,
  requirements: XrplPaymentRequirements,
): Promise<XrplVerifyResult> {
  const paymentPayload = toXrplPaymentPayload(clientPayload, requirements);
  const { ok, status, json } = await facilitatorPost('/verify', {
    paymentPayload,
    paymentRequirements: {
      scheme: requirements.scheme,
      network: requirements.network,
      amount: requirements.amount,
      asset: requirements.asset,
      payTo: requirements.payTo,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds,
      extra: requirements.extra,
    },
  });
  if (!ok) {
    return {
      isValid: false,
      invalidReason:
        (json.invalidReason as string) ||
        (json.error as string) ||
        (json.detail as string) ||
        `xrpl_facilitator_http_${status}`,
    };
  }
  return {
    isValid: Boolean(json.isValid),
    invalidReason: (json.invalidReason as string) || undefined,
    payer: (json.payer as string) || undefined,
  };
}

export async function xrplSettlePayment(
  clientPayload: Record<string, unknown>,
  requirements: XrplPaymentRequirements,
): Promise<XrplSettleResult> {
  const paymentPayload = toXrplPaymentPayload(clientPayload, requirements);
  const { ok, status, json } = await facilitatorPost('/settle', {
    paymentPayload,
    paymentRequirements: {
      scheme: requirements.scheme,
      network: requirements.network,
      amount: requirements.amount,
      asset: requirements.asset,
      payTo: requirements.payTo,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds,
      extra: requirements.extra,
    },
  });
  if (!ok) {
    return {
      success: false,
      error:
        (json.errorReason as string) ||
        (json.error as string) ||
        (json.detail as string) ||
        `xrpl_facilitator_http_${status}`,
    };
  }
  const success = Boolean(json.success);
  return {
    success,
    txHash: (json.transaction as string) || (json.txHash as string) || undefined,
    network: (json.network as string) || requirements.network,
    payer: (json.payer as string) || undefined,
    error: success
      ? undefined
      : (json.errorReason as string) || (json.error as string) || 'settlement_failed',
  };
}

/** Stable hash helper for invoice binding diagnostics (optional). */
export function invoiceIdSha256Hex(invoiceId: string): string {
  return createHash('sha256').update(invoiceId, 'utf8').digest('hex').toUpperCase();
}
