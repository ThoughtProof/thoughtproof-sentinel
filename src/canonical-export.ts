/**
 * M1 signed canonical export envelope
 * -----------------------------------
 * Detached Ed25519 signature over a domain-separated export envelope so
 * PriorSeal (and any receiver) can pin keyId + verify without trusting a
 * live re-call of POST /sentinel/verify.
 *
 * Contract (PriorSeal M1 one-pager, 2026-09-12):
 *
 *   signed_input =
 *     "thoughtproof.sentinel.export.v1" || 0x00 ||
 *     JCS({
 *       artifactSchema,   // inner projection schema
 *       verificationId,
 *       canonical,        // verbatim JCS string of canonical body
 *       digest,           // 0x + sha256(UTF-8(canonical))
 *       keyId,
 *       alg,              // "Ed25519"
 *       signedAt,         // unix seconds
 *       validUntil?       // unix seconds; omit entirely when unused
 *     })
 *
 * Commitment digest is ONLY over canonical body bytes
 * (`hashCanonicalSentinelVerdict`) — PriorSeal commits to decision bytes,
 * not the whole export envelope.
 *
 * Verification order:
 *   1. verify envelope signature over signed_input with pinned keyId
 *   2. recompute sha256 over transported `canonical` string (do NOT re-JCS)
 *   3. require `digest` field equals recompute
 *   4. unique PriorSeal namespace match on that digest (receiver)
 *   5. if validUntil present in signed envelope, apply expiry
 *
 * Pure crypto helpers here. I/O (env key load, well-known doc) is separate.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'crypto';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - canonicalize types are loose; runtime export is the function
import canonicalize from 'canonicalize';
import type { SentinelVerifyResponse } from './types.js';
import {
  buildCanonicalSentinelVerdict,
  hashCanonicalSentinelVerdict,
  serializeCanonicalSentinelVerdict,
  type CanonicalSentinelVerdictBody,
} from './canonical-verdict.js';

/** Domain tag for the export envelope (≠ canonical schema string). */
export const EXPORT_DOMAIN = 'thoughtproof.sentinel.export.v1' as const;

export const EXPORT_ALG = 'Ed25519' as const;

/** Env: PKCS8 PEM or 64-hex seed (32-byte raw seed) for the export signer. */
export const EXPORT_PRIVATE_KEY_ENV = 'SENTINEL_EXPORT_PRIVATE_KEY';

/** Env: key id published in /.well-known/thoughtproof-keys.json */
export const EXPORT_KEY_ID_ENV = 'SENTINEL_EXPORT_KEY_ID';

/**
 * Env: optional TTL seconds for validUntil on the envelope.
 * Unset or empty → omit validUntil entirely (do not invent).
 */
export const EXPORT_TTL_SECONDS_ENV = 'SENTINEL_EXPORT_TTL_SECONDS';

const DEFAULT_KEY_ID = 'tp-sentinel-export-ed25519-2026-09';

/** Fields covered by the envelope signature (JCS object inside signed_input). */
export interface CanonicalExportSignedFields {
  artifactSchema: CanonicalSentinelVerdictBody['artifactSchema'];
  verificationId: string;
  /** Verbatim JCS string of the canonical body — opaque string, not nested object. */
  canonical: string;
  /** 0x + lowercase hex sha256 of UTF-8(canonical). */
  digest: string;
  keyId: string;
  alg: typeof EXPORT_ALG;
  /** Unix seconds. */
  signedAt: number;
  /** Unix seconds; omit when freshness not required. */
  validUntil?: number;
}

/** Wire shape returned to callers / vectors. */
export interface SignedCanonicalExport extends CanonicalExportSignedFields {
  exportSchema: typeof EXPORT_DOMAIN;
  /** Detached Ed25519 signature: 0x + lowercase hex (128 hex chars). */
  signature: string;
}

export interface IssueExportOptions {
  /** Override clock (unix seconds). */
  nowSeconds?: number;
  keyId?: string;
  privateKey: KeyObject | string;
  /** When set, write validUntil = signedAt + ttlSeconds. */
  ttlSeconds?: number;
}

export type ExportVerifyFailureCode =
  | 'missing_fields'
  | 'bad_digest_format'
  | 'digest_mismatch'
  | 'signature_invalid'
  | 'alg_unsupported'
  | 'expired'
  | 'not_yet_valid'
  | 'key_unusable';

export interface ExportVerifyResult {
  ok: boolean;
  code?: ExportVerifyFailureCode;
  detail?: string;
  recomputedDigest?: string;
  keyId?: string;
}

function jcs(value: unknown): string {
  const out = (canonicalize as unknown as (v: unknown) => string)(value);
  if (typeof out !== 'string') {
    throw new Error('canonicalize() did not return a string');
  }
  return out;
}

/**
 * Build the exact bytes signed / verified.
 * Domain || 0x00 || JCS(signed fields). Optional validUntil omitted from object.
 */
export function buildExportSignedInput(fields: CanonicalExportSignedFields): Buffer {
  const body: Record<string, unknown> = {
    artifactSchema: fields.artifactSchema,
    verificationId: fields.verificationId,
    canonical: fields.canonical,
    digest: fields.digest,
    keyId: fields.keyId,
    alg: fields.alg,
    signedAt: fields.signedAt,
  };
  if (fields.validUntil !== undefined) {
    body.validUntil = fields.validUntil;
  }
  return Buffer.concat([
    Buffer.from(EXPORT_DOMAIN, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(jcs(body), 'utf8'),
  ]);
}

/** SHA-256 over UTF-8 bytes of a transported canonical JCS string (no re-JCS). */
export function digestTransportedCanonical(canonicalJcs: string): string {
  return `0x${createHash('sha256').update(canonicalJcs, 'utf8').digest('hex')}`;
}

function normalizeSignatureHex(sig: string): string {
  const h = sig.startsWith('0x') || sig.startsWith('0X') ? sig.slice(2) : sig;
  if (!/^[0-9a-fA-F]{128}$/.test(h)) {
    throw new Error('signature must be 64-byte Ed25519 as 128 hex chars (optional 0x)');
  }
  return `0x${h.toLowerCase()}`;
}

function resolvePrivateKey(key: KeyObject | string): KeyObject {
  if (typeof key !== 'string') return key;
  const trimmed = key.trim();
  if (trimmed.includes('BEGIN')) {
    return createPrivateKey(trimmed);
  }
  // raw 32-byte seed as hex → PKCS8 via Node generate from seed is not direct;
  // accept PKCS8 DER hex OR PEM. Also accept 64-char seed by wrapping PKCS8.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    // PKCS8 Ed25519 private key DER prefix + 32-byte seed
    // 30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 || seed
    const seed = Buffer.from(trimmed, 'hex');
    const pkcs8 = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      seed,
    ]);
    return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  }
  return createPrivateKey(trimmed);
}

export function resolvePublicKey(
  publicKey: KeyObject | string,
): KeyObject {
  if (typeof publicKey !== 'string') return publicKey;
  const trimmed = publicKey.trim();
  if (trimmed.includes('BEGIN')) {
    return createPublicKey(trimmed);
  }
  // raw 32-byte SPKI-less public key hex → SPKI DER
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const raw = Buffer.from(trimmed, 'hex');
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      raw,
    ]);
    return createPublicKey({ key: spki, format: 'der', type: 'spki' });
  }
  return createPublicKey(trimmed);
}

/** Raw 32-byte public key hex from a KeyObject (Ed25519). */
export function publicKeyRawHex(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  // SPKI for Ed25519 is 12-byte header + 32-byte key
  return Buffer.from(der.subarray(der.length - 32)).toString('hex');
}

export function publicKeyPem(publicKey: KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'pem' }) as string;
}

export function generateExportKeyPair(): {
  publicKey: KeyObject;
  privateKey: KeyObject;
  publicKeyHex: string;
  publicKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey,
    privateKey,
    publicKeyHex: publicKeyRawHex(publicKey),
    publicKeyPem: publicKeyPem(publicKey),
  };
}

/**
 * Issue a signed export from a canonical body (or response).
 * Does not mutate the canonical body; validUntil is envelope-only.
 */
export function issueSignedCanonicalExport(
  source: CanonicalSentinelVerdictBody | SentinelVerifyResponse,
  options: IssueExportOptions,
): SignedCanonicalExport {
  const body: CanonicalSentinelVerdictBody =
    'artifactSchema' in source && source.artifactSchema === 'sentinel.verdict.canonical.v1'
      ? source
      : buildCanonicalSentinelVerdict(source as SentinelVerifyResponse);

  const canonical = serializeCanonicalSentinelVerdict(body);
  const digest = hashCanonicalSentinelVerdict(body);
  // Defense: digest must equal hash of transported string
  const transported = digestTransportedCanonical(canonical);
  if (digest !== transported) {
    throw new Error('internal digest mismatch between body hash and transported canonical');
  }

  const signedAt = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const keyId = options.keyId ?? DEFAULT_KEY_ID;
  const fields: CanonicalExportSignedFields = {
    artifactSchema: body.artifactSchema,
    verificationId: body.verificationId,
    canonical,
    digest,
    keyId,
    alg: EXPORT_ALG,
    signedAt,
  };
  if (options.ttlSeconds !== undefined && options.ttlSeconds > 0) {
    fields.validUntil = signedAt + options.ttlSeconds;
  }

  const privateKey = resolvePrivateKey(options.privateKey);
  const signedInput = buildExportSignedInput(fields);
  const sigBuf = cryptoSign(null, signedInput, privateKey);
  const signature = `0x${Buffer.from(sigBuf).toString('hex')}`;

  return {
    exportSchema: EXPORT_DOMAIN,
    ...fields,
    signature,
  };
}

/**
 * Verify a signed export against a pinned public key.
 * Does NOT fetch keys — caller supplies the pin.
 */
export function verifySignedCanonicalExport(
  exportArtifact: SignedCanonicalExport | Record<string, unknown>,
  publicKey: KeyObject | string,
  opts: { nowSeconds?: number; requireValidUntil?: boolean } = {},
): ExportVerifyResult {
  const e = exportArtifact as Partial<SignedCanonicalExport>;
  if (
    typeof e.canonical !== 'string' ||
    typeof e.digest !== 'string' ||
    typeof e.signature !== 'string' ||
    typeof e.keyId !== 'string' ||
    typeof e.verificationId !== 'string' ||
    typeof e.artifactSchema !== 'string' ||
    typeof e.signedAt !== 'number' ||
    e.alg !== EXPORT_ALG
  ) {
    return { ok: false, code: 'missing_fields', detail: 'required export fields missing or wrong type' };
  }
  if (e.alg !== EXPORT_ALG) {
    return { ok: false, code: 'alg_unsupported', detail: String(e.alg), keyId: e.keyId };
  }
  if (!/^0x[0-9a-f]{64}$/.test(e.digest)) {
    return { ok: false, code: 'bad_digest_format', detail: e.digest, keyId: e.keyId };
  }

  const recomputed = digestTransportedCanonical(e.canonical);
  if (recomputed !== e.digest) {
    return {
      ok: false,
      code: 'digest_mismatch',
      detail: 'transported canonical bytes ≠ digest field (DECISION_COMMITMENT_DIGEST_MISMATCH)',
      recomputedDigest: recomputed,
      keyId: e.keyId,
    };
  }

  const fields: CanonicalExportSignedFields = {
    artifactSchema: e.artifactSchema as CanonicalSentinelVerdictBody['artifactSchema'],
    verificationId: e.verificationId,
    canonical: e.canonical,
    digest: e.digest,
    keyId: e.keyId,
    alg: EXPORT_ALG,
    signedAt: e.signedAt,
  };
  if (e.validUntil !== undefined) {
    if (typeof e.validUntil !== 'number') {
      return { ok: false, code: 'missing_fields', detail: 'validUntil must be number when present' };
    }
    fields.validUntil = e.validUntil;
  } else if (opts.requireValidUntil) {
    return { ok: false, code: 'missing_fields', detail: 'validUntil required by caller policy' };
  }

  let pub: KeyObject;
  try {
    pub = resolvePublicKey(publicKey);
  } catch (err) {
    return {
      ok: false,
      code: 'key_unusable',
      detail: err instanceof Error ? err.message : 'public key parse failed',
      keyId: e.keyId,
    };
  }

  let sigHex: string;
  try {
    sigHex = normalizeSignatureHex(e.signature);
  } catch (err) {
    return {
      ok: false,
      code: 'signature_invalid',
      detail: err instanceof Error ? err.message : 'bad signature encoding',
      keyId: e.keyId,
    };
  }

  const signedInput = buildExportSignedInput(fields);
  const sigOk = cryptoVerify(
    null,
    signedInput,
    pub,
    Buffer.from(sigHex.slice(2), 'hex'),
  );
  if (!sigOk) {
    return {
      ok: false,
      code: 'signature_invalid',
      detail: 'Ed25519 verify failed over domain||0x00||JCS(fields)',
      recomputedDigest: recomputed,
      keyId: e.keyId,
    };
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (fields.validUntil !== undefined && now > fields.validUntil) {
    return {
      ok: false,
      code: 'expired',
      detail: `now=${now} validUntil=${fields.validUntil}`,
      recomputedDigest: recomputed,
      keyId: e.keyId,
    };
  }

  return {
    ok: true,
    recomputedDigest: recomputed,
    keyId: e.keyId,
  };
}

export interface LoadedExportSigner {
  privateKey: KeyObject;
  keyId: string;
  ttlSeconds?: number;
}

/**
 * Load signer from process env. Returns null when not configured
 * (verify path stays byte-compatible — no signed_export field).
 */
export function loadExportSignerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LoadedExportSigner | null {
  const raw = env[EXPORT_PRIVATE_KEY_ENV];
  if (!raw || !raw.trim()) return null;
  try {
    const privateKey = resolvePrivateKey(raw);
    const keyId = (env[EXPORT_KEY_ID_ENV] || DEFAULT_KEY_ID).trim() || DEFAULT_KEY_ID;
    const ttlRaw = env[EXPORT_TTL_SECONDS_ENV];
    let ttlSeconds: number | undefined;
    if (ttlRaw !== undefined && String(ttlRaw).trim() !== '') {
      const n = Number(String(ttlRaw).trim());
      if (Number.isFinite(n) && n > 0) ttlSeconds = Math.floor(n);
    }
    return { privateKey, keyId, ttlSeconds };
  } catch (err) {
    console.error(
      '[canonical-export] SENTINEL_EXPORT_PRIVATE_KEY present but unusable:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Issue export when signer configured; otherwise null (omit from response).
 * Never throws into the verify path — signing failure is logged and omitted.
 */
export function maybeIssueSignedExport(
  response: SentinelVerifyResponse,
  env: NodeJS.ProcessEnv = process.env,
  nowSeconds?: number,
): SignedCanonicalExport | null {
  const signer = loadExportSignerFromEnv(env);
  if (!signer) return null;
  try {
    return issueSignedCanonicalExport(response, {
      privateKey: signer.privateKey,
      keyId: signer.keyId,
      ttlSeconds: signer.ttlSeconds,
      nowSeconds,
    });
  } catch (err) {
    console.error(
      '[canonical-export] issue failed (omitting signed_export):',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
