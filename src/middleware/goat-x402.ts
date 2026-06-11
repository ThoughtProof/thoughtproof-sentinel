/**
 * GOAT Network x402 Facilitator Client
 *
 * Adapted from goat-agentkit/networks/goat/adapter.ts for use in Sentinel middleware.
 * HMAC-signed REST calls to GOAT's x402 merchant gateway (api.goatx402.com).
 *
 * ENV:
 *   GOAT_X402_BASE_URL   — default: https://api.goatx402.com
 *   GOAT_X402_API_KEY     — required for GOAT x402 flow
 *   GOAT_X402_API_SECRET  — required for GOAT x402 flow
 *   GOAT_X402_PAYMENT_WALLET — payment wallet on GOAT (defaults to PAYMENT_WALLET)
 *   GOAT_USDC_ADDRESS     — USDC contract on GOAT mainnet
 */

import { createHmac, randomUUID } from 'crypto';

// ── Config ────────────────────────────────────────────────────────────────

export const GOAT_CHAIN_ID = 2345;
export const GOAT_NETWORK = `eip155:${GOAT_CHAIN_ID}`;

export function getGoatConfig() {
  return {
    baseUrl: process.env.GOAT_X402_BASE_URL ?? 'https://api.goatx402.com',
    apiKey: process.env.GOAT_X402_API_KEY,
    apiSecret: process.env.GOAT_X402_API_SECRET,
    paymentWallet:
      process.env.GOAT_X402_PAYMENT_WALLET ??
      process.env.PAYMENT_WALLET ??
      '0xAB9f84864662f980614bD1453dB9950Ef2b82E83',
    usdcAddress: process.env.GOAT_USDC_ADDRESS ?? '',
  };
}

export function isGoatEnabled(): boolean {
  const cfg = getGoatConfig();
  return Boolean(cfg.apiKey && cfg.apiSecret && cfg.usdcAddress);
}

// ── HMAC Signing (matches GOAT gateway expectations) ──────────────────────

function signRequest(
  params: Record<string, unknown>,
  apiKey: string,
  apiSecret: string,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== '') {
      normalized[k] = String(v);
    }
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();

  normalized.api_key = apiKey;
  normalized.timestamp = timestamp;
  normalized.nonce = nonce;

  const payload = Object.keys(normalized)
    .sort()
    .map((k) => `${k}=${normalized[k]}`)
    .join('&');

  const sign = createHmac('sha256', apiSecret).update(payload).digest('hex');

  return {
    'X-API-Key': apiKey,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Sign': sign,
  };
}

// ── HTTP helper ───────────────────────────────────────────────────────────

async function goatRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const cfg = getGoatConfig();
  if (!cfg.apiKey || !cfg.apiSecret) {
    throw new Error('GOAT x402: missing GOAT_X402_API_KEY / GOAT_X402_API_SECRET');
  }

  const headers = signRequest(body ?? {}, cfg.apiKey, cfg.apiSecret);

  const resp = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let data: unknown = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  // 402 is expected for create-order flow
  if (!resp.ok && resp.status !== 402) {
    const msg =
      (data as any)?.error ||
      (data as any)?.message ||
      `GOAT x402 request failed: ${resp.status}`;
    throw new Error(msg);
  }

  return data as T;
}

// ── Payment Verification ──────────────────────────────────────────────────

export interface GoatVerifyResult {
  isValid: boolean;
  orderId?: string;
  invalidReason?: string;
}

/**
 * Verify a GOAT x402 payment.
 *
 * The payer sends a base64-encoded JSON payload containing:
 *   - orderId (from a prior create-order call)
 *   - signature (calldata EIP-712 signature)
 *
 * We verify by checking order status via the GOAT gateway.
 */
export async function goatVerifyPayment(
  payload: Record<string, unknown>,
): Promise<GoatVerifyResult> {
  const orderId = payload.orderId as string | undefined;
  const signature = payload.signature as string | undefined;

  if (!orderId) {
    return { isValid: false, invalidReason: 'Missing orderId in payment payload' };
  }

  // If signature provided but not yet submitted, submit it first
  if (signature) {
    try {
      await goatRequest('POST', `/api/v1/orders/${orderId}/calldata-signature`, { signature });
    } catch (err) {
      return {
        isValid: false,
        orderId,
        invalidReason: `Signature submission failed: ${String(err)}`,
      };
    }
  }

  // Check order status
  try {
    const status = await goatRequest<any>('GET', `/api/v1/orders/${orderId}`);
    const orderStatus = String(status?.status ?? '').toUpperCase();

    // GOAT order lifecycle: CREATED → CHECKOUT_VERIFIED → PAYMENT_CONFIRMED → INVOICED
    // Accept PAYMENT_CONFIRMED or INVOICED as valid payment
    const validStatuses = ['PAYMENT_CONFIRMED', 'INVOICED', 'COMPLETED'];
    if (validStatuses.includes(orderStatus)) {
      return { isValid: true, orderId };
    }

    return {
      isValid: false,
      orderId,
      invalidReason: `Order status is '${orderStatus}', expected one of: ${validStatuses.join(', ')}`,
    };
  } catch (err) {
    return {
      isValid: false,
      orderId,
      invalidReason: `Order status check failed: ${String(err)}`,
    };
  }
}

// ── Payment Settlement ────────────────────────────────────────────────────

export interface GoatSettleResult {
  success: boolean;
  orderId?: string;
  txHash?: string;
  error?: string;
}

/**
 * Settle is a no-op for GOAT — settlement happens on-chain via the GOAT gateway.
 * We just confirm the order reached a terminal paid state.
 */
export async function goatSettlePayment(
  payload: Record<string, unknown>,
): Promise<GoatSettleResult> {
  const orderId = payload.orderId as string | undefined;
  if (!orderId) {
    return { success: false, error: 'Missing orderId' };
  }

  try {
    const status = await goatRequest<any>('GET', `/api/v1/orders/${orderId}`);
    const orderStatus = String(status?.status ?? '').toUpperCase();

    if (['PAYMENT_CONFIRMED', 'INVOICED', 'COMPLETED'].includes(orderStatus)) {
      return {
        success: true,
        orderId,
        txHash: status?.tx_hash ?? status?.txHash ?? undefined,
      };
    }

    return {
      success: false,
      orderId,
      error: `Order not in settled state: ${orderStatus}`,
    };
  } catch (err) {
    return { success: false, orderId, error: String(err) };
  }
}

// ── Create Payment Order (for 402 challenge flow) ─────────────────────────

export interface GoatCreateOrderResult {
  orderId: string;
  status: string;
  raw?: unknown;
}

/**
 * Create a payment order on the GOAT gateway.
 * Used when an agent needs to first create an order before paying.
 */
export async function goatCreateOrder(
  amountWei: string,
  callerAddress?: string,
): Promise<GoatCreateOrderResult> {
  const cfg = getGoatConfig();

  const body = {
    dapp_order_id: `sentinel_${Date.now()}`,
    chain_id: GOAT_CHAIN_ID,
    token_symbol: 'USDC',
    from_address: callerAddress ?? cfg.paymentWallet,
    amount_wei: amountWei,
  };

  const raw = await goatRequest<any>('POST', '/api/v1/orders', body);

  return {
    orderId: raw?.order_id ?? `goat_${Date.now()}`,
    status: 'created',
    raw,
  };
}
