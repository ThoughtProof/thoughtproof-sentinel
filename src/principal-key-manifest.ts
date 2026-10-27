/**
 * ADR-0023 stage 3: server-pinned Ed25519 public keys for one account.
 * Not called from the verify handler. Not enabled for any account.
 * A verified signature does not produce ALLOW.
 *
 * The manifest is not the caller-supplied evidence manifest and not the
 * export key document. Registration rejects the verify caller and
 * X-Sentinel-Agent-Id. No registration authority is accepted here.
 * Receipt time is an argument. This module does not read a clock.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - canonicalize types are loose; runtime export is the function
import canonicalize from 'canonicalize';
import { checkMandateProofTimes } from './mandate-proof-window.js';

/** Representation version named on the ADR-0023 envelope. */
export const PRINCIPAL_MANDATE_SCHEMA = 'sentinel.mandate-proof.v1';

/** Purpose for this path. Other purposes are not accepted here. */
export const PRINCIPAL_MANDATE_PURPOSE = 'action_authorization';

const EXPORT_KEY_SCHEMA = 'thoughtproof.keys.v1';
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const PROOF_FIELDS = new Set([
  'schema_version',
  'nonce',
  'iat',
  'exp',
  'account_id',
  'environment',
  'purpose',
  'principal_kid',
  'signature',
]);

const CALLER_TRUST_FIELDS = new Set([
  'jwks',
  'jwks_url',
  'jwksUrl',
  'key_manifest',
  'key_manifest_ref',
  'keys',
  'x',
  'pubkey',
  'd',
]);

const KEY_FIELDS = new Set([
  'kty',
  'crv',
  'x',
  'kid',
  'alg',
  'status',
  'notBefore',
  'notAfter',
]);

const PRIVATE_KEY_FIELDS = new Set([
  'd',
  'k',
  'priv',
  'private',
  'privateKey',
  'private_key',
  'seed',
]);

const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export type PrincipalKeyStatus = 'active' | 'retired' | 'revoked';

export interface PrincipalPublicKey {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg?: 'EdDSA';
  status: PrincipalKeyStatus;
  notBefore: string | null;
  notAfter: string | null;
}

/** One account's pinned public keys. The private key is never a field. */
export interface PrincipalKeyManifest {
  accountId: string;
  keys: PrincipalPublicKey[];
}

export type PrincipalManifestAnswer =
  | { answered: true; manifest: unknown }
  | { answered: false };

export interface PrincipalManifestStore {
  load(accountId: string): Promise<PrincipalManifestAnswer> | PrincipalManifestAnswer;
}

export interface PrincipalProofFields {
  schema_version: string;
  nonce: string;
  iat: number;
  exp: number;
  account_id: string;
  environment: string;
  purpose: string;
  principal_kid: string;
}

export interface PrincipalMandateInput {
  /** Stage-1 account id. The proof does not select this. */
  authenticatedAccountId: string | undefined;
  mandate: unknown;
  mandateProof: unknown;
  /** Server receipt time, unix seconds. Not read from a clock here. */
  nowSeconds: number;
  /** No store means the manifest cannot be read. There is no memory fallback. */
  store: PrincipalManifestStore | null;
  /**
   * Caller-supplied evidence manifest. Ignored. It is not the principal manifest.
   */
  requestBodyKeyManifest?: unknown;
}

export type PrincipalBlockReason =
  | 'malformed_proof'
  | 'caller_trust_anchor'
  | 'account_mismatch'
  | 'non_positive_window'
  | 'not_yet_valid'
  | 'window_too_long'
  | 'expired'
  | 'unknown_kid'
  | 'revoked'
  | 'retired'
  | 'key_not_yet_valid'
  | 'key_expired'
  | 'signature_invalid';

export type PrincipalUnavailableCode =
  | 'ACCOUNT_UNAVAILABLE'
  | 'RECEIPT_TIME_UNUSABLE'
  | 'MANIFEST_UNAVAILABLE'
  | 'MANIFEST_MALFORMED';

export type PrincipalMandateResult =
  | {
      ok: true;
      accountId: string;
      principalKid: string;
      mandateSource: 'principal_signed';
    }
  | { ok: false; verdict: 'BLOCK'; reason: PrincipalBlockReason }
  | { ok: false; httpStatus: 503; code: PrincipalUnavailableCode };

export type GateVerdict = 'ALLOW' | 'BLOCK' | 'UNCERTAIN';

export interface PrincipalRegistrationAttempt {
  apiKey?: string;
  agentIdHeader?: string;
  accountId?: string;
  manifest?: unknown;
  requestBodyKeyManifest?: unknown;
  write?: (accountId: string, manifest: unknown) => void;
}

export interface PrincipalRegistrationResult {
  ok: false;
  httpStatus: 503;
  code: 'REGISTRATION_UNAUTHORIZED';
}

function block(reason: PrincipalBlockReason): PrincipalMandateResult {
  return { ok: false, verdict: 'BLOCK', reason };
}

function unavailable(code: PrincipalUnavailableCode): PrincipalMandateResult {
  return { ok: false, httpStatus: 503, code };
}

function jcs(value: unknown): string | null {
  try {
    const out = (canonicalize as (input: unknown) => string | undefined)(value);
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function unixFromIso(iso: string): number | null {
  if (!ISO_SECOND.test(iso)) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * UTF-8 JCS of the versioned object. `signature` is not included.
 * ADR-0023 also names a domain separator distinct from the export domain
 * and does not give that separator. These bytes are JCS only.
 */
export function principalMandateSignedBytes(
  mandate: unknown,
  proof: PrincipalProofFields,
): Buffer | null {
  const canonical = jcs({
    schema_version: proof.schema_version,
    mandate,
    nonce: proof.nonce,
    iat: proof.iat,
    exp: proof.exp,
    principal_kid: proof.principal_kid,
    account_id: proof.account_id,
    environment: proof.environment,
    purpose: proof.purpose,
  });
  if (canonical == null) return null;
  return Buffer.from(canonical, 'utf8');
}

function publicKeyFromOkpX(x: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(x)) return false;
  const raw = Buffer.from(x, 'base64url');
  if (raw.length !== 32) return false;
  if (raw.toString('base64url') !== x) return false;
  try {
    createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    return true;
  } catch {
    return false;
  }
}

function verifyEd25519(message: Buffer, signatureHex: string, x: string): boolean {
  const hex = signatureHex.startsWith('0x') || signatureHex.startsWith('0X')
    ? signatureHex.slice(2)
    : signatureHex;
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) return false;
  if (!/^[A-Za-z0-9_-]{43}$/.test(x)) return false;
  const raw = Buffer.from(x, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== x) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(null, message, publicKey, Buffer.from(hex, 'hex')) === true;
  } catch {
    return false;
  }
}

function parseProof(
  value: unknown,
): { ok: true; proof: PrincipalProofFields; signature: string } | { ok: false; result: PrincipalMandateResult } {
  if (!isPlainObject(value)) return { ok: false, result: block('malformed_proof') };
  const keys = Object.keys(value);
  if (keys.some((key) => CALLER_TRUST_FIELDS.has(key))) {
    return { ok: false, result: block('caller_trust_anchor') };
  }
  if (keys.some((key) => !PROOF_FIELDS.has(key))) {
    return { ok: false, result: block('malformed_proof') };
  }

  const schema = value.schema_version;
  const nonce = value.nonce;
  const iat = value.iat;
  const exp = value.exp;
  const accountId = value.account_id;
  const environment = value.environment;
  const purpose = value.purpose;
  const kid = value.principal_kid;
  const signature = value.signature;

  if (schema !== PRINCIPAL_MANDATE_SCHEMA || purpose !== PRINCIPAL_MANDATE_PURPOSE) {
    return { ok: false, result: block('malformed_proof') };
  }
  if (!isNonEmptyString(nonce) || !isNonEmptyString(environment) || !isNonEmptyString(kid)) {
    return { ok: false, result: block('malformed_proof') };
  }
  if (!isNonEmptyString(accountId)) return { ok: false, result: block('malformed_proof') };
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || iat < 0 || exp < 0) {
    return { ok: false, result: block('malformed_proof') };
  }
  if (typeof signature !== 'string') return { ok: false, result: block('malformed_proof') };
  const hex = signature.startsWith('0x') || signature.startsWith('0X') ? signature.slice(2) : signature;
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) return { ok: false, result: block('malformed_proof') };

  return {
    ok: true,
    signature,
    proof: {
      schema_version: schema,
      nonce,
      iat,
      exp,
      account_id: accountId,
      environment,
      purpose,
      principal_kid: kid,
    },
  };
}

function parseBound(value: unknown): { ok: true; unix: number | null } | { ok: false } {
  if (value === null) return { ok: true, unix: null };
  if (typeof value !== 'string') return { ok: false };
  const unix = unixFromIso(value);
  if (unix == null) return { ok: false };
  return { ok: true, unix };
}

function parseManifest(
  value: unknown,
  accountId: string,
): { ok: true; keys: PrincipalPublicKey[] } | { ok: false } {
  if (!isPlainObject(value)) return { ok: false };
  if (value.schema === EXPORT_KEY_SCHEMA || value.version !== undefined) return { ok: false };
  const top = Object.keys(value);
  if (top.some((key) => key !== 'accountId' && key !== 'keys')) return { ok: false };
  if (value.accountId !== accountId) return { ok: false };
  if (!Array.isArray(value.keys)) return { ok: false };

  const keys: PrincipalPublicKey[] = [];
  const seen = new Set<string>();
  for (const entry of value.keys) {
    if (!isPlainObject(entry)) return { ok: false };
    const names = Object.keys(entry);
    if (names.some((name) => PRIVATE_KEY_FIELDS.has(name))) return { ok: false };
    if (names.some((name) => !KEY_FIELDS.has(name))) return { ok: false };
    if (entry.kty !== 'OKP' || entry.crv !== 'Ed25519') return { ok: false };
    if (entry.alg !== undefined && entry.alg !== 'EdDSA') return { ok: false };
    if (!isNonEmptyString(entry.kid) || typeof entry.x !== 'string') return { ok: false };
    if (!publicKeyFromOkpX(entry.x)) return { ok: false };
    if (entry.status !== 'active' && entry.status !== 'retired' && entry.status !== 'revoked') {
      return { ok: false };
    }
    if (!Object.prototype.hasOwnProperty.call(entry, 'notBefore')) return { ok: false };
    if (!Object.prototype.hasOwnProperty.call(entry, 'notAfter')) return { ok: false };
    const notBefore = parseBound(entry.notBefore);
    const notAfter = parseBound(entry.notAfter);
    if (!notBefore.ok || !notAfter.ok) return { ok: false };
    if (seen.has(entry.kid)) return { ok: false };
    seen.add(entry.kid);
    const key: PrincipalPublicKey = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: entry.x,
      kid: entry.kid,
      status: entry.status,
      notBefore: notBefore.unix == null ? null : (entry.notBefore as string),
      notAfter: notAfter.unix == null ? null : (entry.notAfter as string),
    };
    if (entry.alg === 'EdDSA') key.alg = 'EdDSA';
    keys.push(key);
  }
  return { ok: true, keys };
}

/**
 * `active` at receipt time: status is active and `now` is inside the window.
 * Endpoints match export signer readiness (`now < notBefore` and `now > notAfter`
 * are outside). The 30-second proof skew does not move this window.
 * `iat` is not an argument. `malformed` means the window cannot be read.
 */
function keyFailureAtReceipt(
  key: PrincipalPublicKey,
  nowSeconds: number,
): PrincipalBlockReason | 'malformed' | null {
  if (key.status === 'revoked') return 'revoked';
  if (key.status === 'retired') return 'retired';
  const notBefore = key.notBefore == null ? null : unixFromIso(key.notBefore);
  const notAfter = key.notAfter == null ? null : unixFromIso(key.notAfter);
  if (key.notBefore != null && notBefore == null) return 'malformed';
  if (key.notAfter != null && notAfter == null) return 'malformed';
  if (notBefore != null && nowSeconds < notBefore) return 'key_not_yet_valid';
  if (notAfter != null && nowSeconds > notAfter) return 'key_expired';
  return null;
}

function isAnswer(value: unknown): value is PrincipalManifestAnswer {
  if (!isPlainObject(value)) return false;
  return value.answered === true || value.answered === false;
}

/**
 * Reject every registration attempt. The verify API key and
 * X-Sentinel-Agent-Id are not registration authority. Who may pin a key
 * is still open, so this entry point writes nothing.
 */
export function registerPrincipalKey(
  attempt: PrincipalRegistrationAttempt,
): PrincipalRegistrationResult {
  void attempt;
  return { ok: false, httpStatus: 503, code: 'REGISTRATION_UNAUTHORIZED' };
}

/**
 * Leave the gate verdict in place when the signature verifies.
 * A BLOCK gate stays BLOCK. A failed check is BLOCK, or UNCERTAIN when
 * the failure is HTTP 503, and neither of those is ALLOW.
 */
export function verdictWithPrincipalCheck(
  gateVerdict: GateVerdict,
  check: PrincipalMandateResult,
): GateVerdict {
  if (gateVerdict === 'BLOCK') return 'BLOCK';
  if (!check.ok) return 'httpStatus' in check ? 'UNCERTAIN' : 'BLOCK';
  return gateVerdict;
}

/**
 * Check one proof against the pinned manifest for the authenticated account.
 * Success is `mandateSource: principal_signed`. It is not ALLOW.
 */
export async function verifyPrincipalMandate(
  input: PrincipalMandateInput,
): Promise<PrincipalMandateResult> {
  void input.requestBodyKeyManifest;

  if (!Number.isSafeInteger(input.nowSeconds) || input.nowSeconds < 0) {
    return unavailable('RECEIPT_TIME_UNUSABLE');
  }
  if (!isNonEmptyString(input.authenticatedAccountId)) {
    return unavailable('ACCOUNT_UNAVAILABLE');
  }
  const accountId = input.authenticatedAccountId;

  const parsed = parseProof(input.mandateProof);
  if (!parsed.ok) return parsed.result;
  if (parsed.proof.account_id !== accountId) return block('account_mismatch');
  if (!isPlainObject(input.mandate)) return block('malformed_proof');

  const times = checkMandateProofTimes(
    { iat: parsed.proof.iat, exp: parsed.proof.exp },
    input.nowSeconds,
  );
  if (!times.ok) return block(times.reason);

  if (!input.store) return unavailable('MANIFEST_UNAVAILABLE');

  let loaded: unknown;
  try {
    loaded = await input.store.load(accountId);
  } catch {
    return unavailable('MANIFEST_UNAVAILABLE');
  }
  if (!isAnswer(loaded) || loaded.answered === false) {
    return unavailable('MANIFEST_UNAVAILABLE');
  }
  if (loaded.manifest == null) return block('unknown_kid');

  const manifest = parseManifest(loaded.manifest, accountId);
  if (!manifest.ok) return unavailable('MANIFEST_MALFORMED');

  const key = manifest.keys.find((entry) => entry.kid === parsed.proof.principal_kid);
  if (!key) return block('unknown_kid');

  const keyFailure = keyFailureAtReceipt(key, input.nowSeconds);
  if (keyFailure === 'malformed') return unavailable('MANIFEST_MALFORMED');
  if (keyFailure) return block(keyFailure);

  const signed = principalMandateSignedBytes(input.mandate, parsed.proof);
  if (!signed) return block('malformed_proof');
  if (!verifyEd25519(signed, parsed.signature, key.x)) return block('signature_invalid');

  return {
    ok: true,
    accountId,
    principalKid: key.kid,
    mandateSource: 'principal_signed',
  };
}
