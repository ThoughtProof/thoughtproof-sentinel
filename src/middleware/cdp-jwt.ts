/**
 * cdp-jwt.ts — Bearer token generation for Coinbase CDP API (EdDSA / Ed25519).
 *
 * Zero-dependency (node:crypto only) — serverless-friendly.
 *
 * CDP "Secret API Key" format (portal-issued, key id = UUID):
 *   secret = base64-encoded 64-byte Ed25519 keypair (32B seed + 32B pubkey).
 *   We wrap the seed in a PKCS8 envelope and sign with algorithm Ed25519.
 *
 * Env:
 *   X402_CDP_KEY_ID     — CDP API key id (UUID)
 *   X402_CDP_KEY_SECRET — CDP API key secret (base64, 88 chars)
 *
 * JWT requirements (CDP "Generate Bearer Token" docs):
 *   header:  { alg: "EdDSA", kid: <key id>, typ: "JWT", nonce: <random> }
 *   payload: { sub: <key id>, iss: "cdp", nbf, exp (≤ +2min), uri: "<METHOD> <host><path>" }
 */
import { createPrivateKey, sign as cryptoSign, randomBytes } from 'crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj)));
}

/** Accepts standard base64 OR base64url secret. Returns the raw 64-byte keypair. */
function decodeSecret(secretB64: string): Buffer {
  const raw = Buffer.from(secretB64, 'base64');
  if (raw.length !== 64) {
    throw new Error(`CDP key secret must decode to 64 bytes (Ed25519 keypair), got ${raw.length}`);
  }
  return raw;
}

/**
 * Generate a CDP Bearer JWT for one request.
 * @param keyId      CDP API key id (UUID)
 * @param secretB64  CDP API key secret (base64 64-byte Ed25519 keypair)
 * @param method     HTTP method, e.g. "POST"
 * @param host       e.g. "api.cdp.coinbase.com"
 * @param path       e.g. "/platform/v2/x402/verify"
 */
export function generateCdpJwt(
  keyId: string,
  secretB64: string,
  method: string,
  host: string,
  path: string,
): string {
  const raw = decodeSecret(secretB64);
  const seed = raw.subarray(0, 32);
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });

  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'EdDSA',
    kid: keyId,
    typ: 'JWT',
    nonce: randomBytes(16).toString('hex'),
  };
  const payload = {
    sub: keyId,
    iss: 'cdp',
    nbf: now,
    exp: now + 120,
    uri: `${method.toUpperCase()} ${host}${path}`,
  };

  const unsigned = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = cryptoSign(null, Buffer.from(unsigned), key);
  return `${unsigned}.${b64url(signature)}`;
}

/** Returns true when CDP facilitator credentials are configured. */
export function hasCdpCredentials(): boolean {
  return Boolean(process.env.X402_CDP_KEY_ID && process.env.X402_CDP_KEY_SECRET);
}
