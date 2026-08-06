/**
 * L1 off-chain issuance: Ed25519 signature over JCS canonical Sentinel verdict.
 *
 * Third party verifies:
 *   1. Fetch https://sentinel.thoughtproof.ai/.well-known/validation-keys.json
 *   2. Recompute JCS bytes of `canonical` (or of body with signature fields stripped)
 *   3. crypto.verify Ed25519(pubkey, bytes, signature)
 *
 * Env (one of):
 *   VALIDATION_ED25519_PRIVATE_KEY_PEM  — PKCS8 PEM, use \n for newlines in env
 *   VALIDATION_ED25519_PRIVATE_KEY_PATH — absolute path to PEM file (local/dev)
 *
 * Never log the private key material.
 */
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'crypto';
import { readFileSync } from 'fs';
import {
  buildCanonicalSentinelVerdict,
  hashCanonicalSentinelVerdict,
  serializeCanonicalSentinelVerdict,
  type CanonicalSentinelVerdictBody,
} from './canonical-verdict.js';
import type { SentinelVerifyResponse } from './types.js';

export const VALIDATION_KEY_ID = 'tp-validation-ed25519-2026-07';
export const VALIDATION_PUBLIC_KEY_REF =
  'https://sentinel.thoughtproof.ai/.well-known/validation-keys.json#tp-validation-ed25519-2026-07';
export const ISSUE_LEVEL_SIGN = 'jws-ed25519' as const;
/** Must match well-known canonicalization.profiles + signature.canonicalization */
export const CANONICALIZATION_PROFILE = 'rfc8785-canonicalize-utf8-v1' as const;

export interface IssuedSignAttestation {
  prepared: true;
  issued: true;
  level: typeof ISSUE_LEVEL_SIGN;
  verificationId: string;
  canonicalHash: string;
  /** JCS (RFC 8785 via `canonicalize`) bytes as UTF-8 string — what was signed */
  canonicalJson: string;
  canonical: CanonicalSentinelVerdictBody;
  signature: {
    alg: 'Ed25519';
    keyId: string;
    value: string; // 0x-hex
    publicKeyRef: string;
    signedAt: string;
    canonicalization: 'rfc8785-canonicalize-utf8-v1';
  };
  /** Echo of EAS-oriented input fingerprints when provided by caller */
  claim_hash?: string;
  evidence_hash?: string;
  schema_uid?: string;
}

export interface IssueSignOptions {
  claim_hash?: string;
  evidence_hash?: string;
  schema_uid?: string;
}

function loadPrivateKeyPem(): string | null {
  const inline = process.env.VALIDATION_ED25519_PRIVATE_KEY_PEM;
  if (inline && inline.trim()) {
    return inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline;
  }
  const path = process.env.VALIDATION_ED25519_PRIVATE_KEY_PATH;
  if (path && path.trim()) {
    try {
      return readFileSync(path.trim(), 'utf8');
    } catch {
      return null;
    }
  }
  return null;
}

/** True when L1 signing can run in this process. */
export function isSignIssuanceConfigured(): boolean {
  return !!loadPrivateKeyPem();
}

export function signCanonicalBody(
  body: CanonicalSentinelVerdictBody,
  opts: IssueSignOptions = {},
): IssuedSignAttestation {
  const pem = loadPrivateKeyPem();
  if (!pem) {
    throw new Error('[sentinel-issue-sign] VALIDATION_ED25519_PRIVATE_KEY_PEM/PATH not configured');
  }

  const canonicalJson = serializeCanonicalSentinelVerdict(body);
  const canonicalHash = hashCanonicalSentinelVerdict(body);
  const priv = createPrivateKey(pem);
  const sig = cryptoSign(null, Buffer.from(canonicalJson, 'utf8'), priv);

  return {
    prepared: true,
    issued: true,
    level: ISSUE_LEVEL_SIGN,
    verificationId: body.verificationId,
    canonicalHash,
    canonicalJson,
    canonical: body,
    signature: {
      alg: 'Ed25519',
      keyId: VALIDATION_KEY_ID,
      value: '0x' + sig.toString('hex'),
      publicKeyRef: VALIDATION_PUBLIC_KEY_REF,
      signedAt: new Date().toISOString(),
      canonicalization: CANONICALIZATION_PROFILE,
    },
    ...(opts.claim_hash ? { claim_hash: opts.claim_hash } : {}),
    ...(opts.evidence_hash ? { evidence_hash: opts.evidence_hash } : {}),
    ...(opts.schema_uid ? { schema_uid: opts.schema_uid } : {}),
  };
}

export function issueSignFromVerifyResponse(
  response: SentinelVerifyResponse,
  opts: IssueSignOptions = {},
): IssuedSignAttestation {
  const body = buildCanonicalSentinelVerdict(response);
  return signCanonicalBody(body, opts);
}

/**
 * Verify an L1 attestation against a PEM public key (tests / offline).
 * Production third parties should load pubkey from well-known JSON.
 */
export function verifyIssuedSignAttestation(
  att: IssuedSignAttestation,
  publicKeyPem: string,
): { ok: boolean; reason?: string } {
  try {
    const recomputed = serializeCanonicalSentinelVerdict(att.canonical);
    if (recomputed !== att.canonicalJson) {
      return { ok: false, reason: 'canonicalJson_mismatch' };
    }
    const hash = '0x' + createHash('sha256').update(recomputed, 'utf8').digest('hex');
    if (hash !== att.canonicalHash) {
      return { ok: false, reason: 'canonicalHash_mismatch' };
    }
    const pub = createPublicKey(publicKeyPem);
    const ok = cryptoVerify(
      null,
      Buffer.from(att.canonicalJson, 'utf8'),
      pub,
      Buffer.from(att.signature.value.replace(/^0x/, ''), 'hex'),
    );
    return ok ? { ok: true } : { ok: false, reason: 'signature_invalid' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'verify_error' };
  }
}
