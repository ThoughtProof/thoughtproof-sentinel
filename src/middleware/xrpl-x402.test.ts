/**
 * Unit tests for XRPL x402 rail — pure helpers + facilitator body shape.
 * No live facilitator calls (those need funded XRPL wallets).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('xrpl-x402 helpers', () => {
  const ENV_KEYS = [
    'XRPL_PAY_TO',
    'XRPL_FACILITATOR_URL',
    'XRPL_NETWORK',
    'XRPL_ASSET',
    'XRPL_RLUSD_ISSUER',
    'XRPL_XRP_USD',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  it('isXrplEnabled is false without XRPL_PAY_TO', async () => {
    delete process.env.XRPL_PAY_TO;
    vi.resetModules();
    const { isXrplEnabled } = await import('./xrpl-x402.js');
    expect(isXrplEnabled()).toBe(false);
  });

  it('isXrplEnabled is true with classic address', async () => {
    process.env.XRPL_PAY_TO = 'rN7n7otQDd6FczFgLdlqtyMVrn3qMHrwk';
    process.env.XRPL_NETWORK = 'xrpl:0';
    vi.resetModules();
    const { isXrplEnabled } = await import('./xrpl-x402.js');
    expect(isXrplEnabled()).toBe(true);
  });

  it('usdPriceToXrplAmount keeps RLUSD 1:1 as decimal', async () => {
    process.env.XRPL_PAY_TO = 'rN7n7otQDd6FczFgLdlqtyMVrn3qMHrwk';
    process.env.XRPL_ASSET = '524C555344000000000000000000000000000000';
    vi.resetModules();
    const { usdPriceToXrplAmount } = await import('./xrpl-x402.js');
    expect(usdPriceToXrplAmount('0.005')).toBe('0.005');
    expect(usdPriceToXrplAmount('0.008')).toBe('0.008');
  });

  it('usdPriceToXrplAmount converts XRP to drops', async () => {
    process.env.XRPL_PAY_TO = 'rN7n7otQDd6FczFgLdlqtyMVrn3qMHrwk';
    process.env.XRPL_ASSET = 'XRP';
    process.env.XRPL_XRP_USD = '0.5'; // $0.5/XRP → $0.005 = 0.01 XRP = 10000 drops
    vi.resetModules();
    const { usdPriceToXrplAmount } = await import('./xrpl-x402.js');
    expect(usdPriceToXrplAmount('0.005')).toBe('10000');
  });

  it('buildXrplRequirements includes invoiceId + issuer for RLUSD', async () => {
    process.env.XRPL_PAY_TO = 'rN7n7otQDd6FczFgLdlqtyMVrn3qMHrwk';
    process.env.XRPL_NETWORK = 'xrpl:0';
    delete process.env.XRPL_ASSET; // default RLUSD
    vi.resetModules();
    const { buildXrplRequirements, RLUSD_HEX, RLUSD_ISSUER_MAINNET } = await import(
      './xrpl-x402.js'
    );
    const req = buildXrplRequirements({
      usdPrice: '0.005',
      invoiceId: 'tp_test_inv_1',
    });
    expect(req.scheme).toBe('exact');
    expect(req.network).toBe('xrpl:0');
    expect(req.asset).toBe(RLUSD_HEX);
    expect(req.payTo).toBe('rN7n7otQDd6FczFgLdlqtyMVrn3qMHrwk');
    expect(req.amount).toBe('0.005');
    expect(req.extra.invoiceId).toBe('tp_test_inv_1');
    expect(req.extra.issuer).toBe(RLUSD_ISSUER_MAINNET);
    expect(req.extra.sourceTag).toBe(804681468);
  });

  it('toXrplPaymentPayload wraps v1-ish payload into v2', async () => {
    process.env.XRPL_PAY_TO = 'rN7n7otQDd6FczFgLdlqtyMVrn3qMHrwk';
    vi.resetModules();
    const { buildXrplRequirements, toXrplPaymentPayload } = await import('./xrpl-x402.js');
    const req = buildXrplRequirements({ usdPrice: '0.005', invoiceId: 'inv' });
    const v2 = toXrplPaymentPayload(
      {
        scheme: 'exact',
        network: 'xrpl:0',
        payload: { signedTxBlob: 'DEADBEEF', invoiceId: 'inv' },
      },
      req,
    );
    expect(v2.x402Version).toBe(2);
    expect((v2.accepted as any).network).toBe('xrpl:0');
    expect((v2.payload as any).signedTxBlob).toBe('DEADBEEF');
  });

  it('xrplVerifyPayment posts paymentPayload + paymentRequirements (no CDP JWT)', async () => {
    process.env.XRPL_PAY_TO = 'rN7n7otQDd6FczFgLdlqtyMVrn3qMHrwk';
    process.env.XRPL_FACILITATOR_URL = 'https://xrpl-facilitator-test.example';
    vi.resetModules();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ isValid: false, invalidReason: 'bad_sig', payer: 'rPayer' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { buildXrplRequirements, xrplVerifyPayment } = await import('./xrpl-x402.js');
    const req = buildXrplRequirements({ usdPrice: '0.005', invoiceId: 'inv' });
    const result = await xrplVerifyPayment(
      { payload: { signedTxBlob: '00', invoiceId: 'inv' }, network: 'xrpl:0' },
      req,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('bad_sig');
    expect(result.payer).toBe('rPayer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://xrpl-facilitator-test.example/verify');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(body.paymentPayload).toBeTruthy();
    expect(body.paymentRequirements.network).toBe('xrpl:0');
    expect(body.paymentRequirements.extra.invoiceId).toBe('inv');
    // Must NOT look like CDP body
    expect(body.x402Version).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('isXrplNetwork matches xrpl:0 / xrpl:1', async () => {
    const { isXrplNetwork } = await import('./xrpl-x402.js');
    expect(isXrplNetwork('xrpl:0')).toBe(true);
    expect(isXrplNetwork('xrpl:1')).toBe(true);
    expect(isXrplNetwork('eip155:8453')).toBe(false);
    expect(isXrplNetwork('base')).toBe(false);
  });
});
