/**
 * Client-side ADR-0023 `mandate_proof` signer.
 *
 * The bytes are the ones `verifyPrincipalMandate` checks, which is what
 * `POST /sentinel/verify` checks once enforcement is on: UTF-8
 * `thoughtproof.sentinel.mandate.v1`, one 0x00 byte, then
 * UTF-8 JCS of one envelope. The envelope is the normalized mandate
 * plus the proof fields except `signature`. `normalizeMandate` runs
 * first, because the request path verifies that object, not the raw
 * mandate and not a salted digest.
 *
 * This module does not read an enforce flag, does not pin a key, and
 * does not talk to a store. A failure returns no proof.
 */

import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import {
  MANDATE_PROOF_MAX_WINDOW_SECONDS,
  checkMandateProofTimes,
} from './mandate-proof-window.js';
import { normalizeMandate } from './mandate-normalize.js';
import { MANDATE_PROOF_SIGNATURE_PATTERN } from './mandate-proof-signature.js';
import {
  PRINCIPAL_MANDATE_PURPOSE,
  PRINCIPAL_MANDATE_SCHEMA,
  isPrincipalEnvironment,
  principalMandateSignedBytes,
  type PrincipalEnvironment,
  type PrincipalProofFields,
} from './principal-key-manifest.js';

/** PEM path. The private key is never taken from an argument. */
export const SENTINEL_PRINCIPAL_PRIVATE_KEY_PATH = 'SENTINEL_PRINCIPAL_PRIVATE_KEY_PATH';

/** Stderr line on every closed failure. Stdout stays empty. */
export const MANDATE_PROOF_SIGN_FAILURE = 'mandate_proof_sign_failed';

const PEM_MAX_BYTES = 8192;
const BODY_MAX_BYTES = 1_048_576;
const NONCE_BYTES = 32;

const PROOF_KEYS = [
  'schema_version',
  'nonce',
  'iat',
  'exp',
  'account_id',
  'environment',
  'purpose',
  'principal_kid',
  'signature',
] as const;

export interface SignedMandateProof {
  schema_version: typeof PRINCIPAL_MANDATE_SCHEMA;
  nonce: string;
  iat: number;
  exp: number;
  account_id: string;
  environment: PrincipalEnvironment;
  purpose: typeof PRINCIPAL_MANDATE_PURPOSE;
  principal_kid: string;
  signature: string;
}

export interface MandateProofSignInput {
  /** Verify request body. The signed mandate is `body.mandate`. */
  requestBody: unknown;
  privateKey: KeyObject;
  accountId: string;
  principalKid: string;
  environment: string;
  /** Signer clock, unix seconds. Not written as its own field. */
  nowSeconds: number;
  nonce?: string;
  iat?: number;
  exp?: number;
}

export type MandateProofSignResult =
  | { ok: true; mandate_proof: SignedMandateProof }
  | { ok: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isToken(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max && /^[\x21-\x7e]+$/.test(value);
}

function isUnixSeconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isEd25519PrivateKey(key: KeyObject): boolean {
  return key.type === 'private' && key.asymmetricKeyType === 'ed25519';
}

/**
 * Parse one unencrypted Ed25519 PKCS#8 (or otherwise PEM) private key.
 * A public key, an encrypted key, and any other type are refused.
 * The PEM text is not returned.
 */
export function loadEd25519PrivateKeyPem(pem: string): KeyObject | null {
  try {
    if (typeof pem !== 'string' || pem.length === 0 || pem.length > PEM_MAX_BYTES) return null;
    const key = createPrivateKey({ key: pem, format: 'pem' });
    if (!isEd25519PrivateKey(key)) return null;
    return key;
  } catch {
    return null;
  }
}

/**
 * Sign one request body's mandate. Returns no object unless the
 * signature self-checks against the same bytes the verifier uses.
 */
export function signMandateProof(input: MandateProofSignInput): MandateProofSignResult {
  try {
    if (!isEd25519PrivateKey(input.privateKey)) return { ok: false };
    if (!isToken(input.accountId, 1, 128)) return { ok: false };
    if (!isToken(input.principalKid, 1, 128)) return { ok: false };
    if (!isPrincipalEnvironment(input.environment)) return { ok: false };
    if (!isUnixSeconds(input.nowSeconds)) return { ok: false };
    if (!isPlainObject(input.requestBody)) return { ok: false };
    if (!Object.prototype.hasOwnProperty.call(input.requestBody, 'mandate')) return { ok: false };

    const normalization = normalizeMandate(input.requestBody.mandate);
    if (!normalization.ok) return { ok: false };

    const iat = input.iat === undefined ? input.nowSeconds : input.iat;
    const exp = input.exp === undefined ? iat + MANDATE_PROOF_MAX_WINDOW_SECONDS : input.exp;
    if (!isUnixSeconds(iat) || !isUnixSeconds(exp)) return { ok: false };
    const times = checkMandateProofTimes({ iat, exp }, input.nowSeconds);
    if (!times.ok) return { ok: false };

    const nonce = input.nonce === undefined
      ? randomBytes(NONCE_BYTES).toString('hex')
      : input.nonce;
    if (!isToken(nonce, 16, 128)) return { ok: false };

    const fields: PrincipalProofFields = {
      schema_version: PRINCIPAL_MANDATE_SCHEMA,
      nonce,
      iat,
      exp,
      account_id: input.accountId,
      environment: input.environment,
      purpose: PRINCIPAL_MANDATE_PURPOSE,
      principal_kid: input.principalKid,
    };
    const signed = principalMandateSignedBytes(normalization.mandate, fields);
    if (!signed) return { ok: false };

    const signature = sign(null, signed, input.privateKey).toString('hex');
    if (!MANDATE_PROOF_SIGNATURE_PATTERN.test(signature)) return { ok: false };
    const publicKey = createPublicKey(input.privateKey);
    if (verify(null, signed, publicKey, Buffer.from(signature, 'hex')) !== true) {
      return { ok: false };
    }

    const mandate_proof: SignedMandateProof = {
      schema_version: PRINCIPAL_MANDATE_SCHEMA,
      nonce: fields.nonce,
      iat: fields.iat,
      exp: fields.exp,
      account_id: fields.account_id,
      environment: input.environment,
      purpose: PRINCIPAL_MANDATE_PURPOSE,
      principal_kid: fields.principal_kid,
      signature,
    };
    return { ok: true, mandate_proof };
  } catch {
    return { ok: false };
  }
}

const VALUE_FLAGS = new Set([
  '--body',
  '--account-id',
  '--kid',
  '--environment',
  '--nonce',
  '--iat',
  '--exp',
  '--now',
]);

function parseArgs(argv: readonly string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !VALUE_FLAGS.has(flag)) return null;
    if (Object.prototype.hasOwnProperty.call(out, flag)) return null;
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) return null;
    out[flag] = value;
    index += 1;
  }
  return out;
}

function parseUnixFlag(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  if (!/^\d{1,15}$/.test(value)) return null;
  const parsed = Number(value);
  if (!isUnixSeconds(parsed)) return null;
  return parsed;
}

function readBoundedFile(path: string, maxBytes: number): Buffer | null {
  try {
    if (path.length === 0 || path.includes('\0')) return null;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    const bytes = readFileSync(path);
    if (bytes.length !== stat.size || bytes.length > maxBytes) return null;
    return bytes;
  } catch {
    return null;
  }
}

export interface MandateProofCliInput {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  stdout?: { write(chunk: string): void };
  stderr?: { write(chunk: string): void };
}

/**
 * CLI entry. Exit 0 writes one `mandate_proof` JSON object to stdout.
 * Exit 2 writes nothing to stdout. Key material is not written.
 */
export function signMandateProofCli(input: MandateProofCliInput): number {
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  const fail = (): number => {
    stderr.write(`${MANDATE_PROOF_SIGN_FAILURE}\n`);
    return 2;
  };
  try {
    const args = parseArgs(input.argv);
    if (!args) return fail();
    const bodyPath = args['--body'];
    const accountId = args['--account-id'];
    const principalKid = args['--kid'];
    const environment = args['--environment'];
    if (!bodyPath || !accountId || !principalKid || !environment) return fail();

    const keyPath = input.env[SENTINEL_PRINCIPAL_PRIVATE_KEY_PATH];
    if (typeof keyPath !== 'string') return fail();
    const pemBytes = readBoundedFile(keyPath.trim(), PEM_MAX_BYTES);
    if (!pemBytes) return fail();
    const privateKey = loadEd25519PrivateKeyPem(pemBytes.toString('utf8'));
    if (!privateKey) return fail();

    const bodyBytes = readBoundedFile(bodyPath, BODY_MAX_BYTES);
    if (!bodyBytes) return fail();
    let requestBody: unknown;
    try {
      requestBody = JSON.parse(bodyBytes.toString('utf8')) as unknown;
    } catch {
      return fail();
    }

    const nowFlag = parseUnixFlag(args['--now']);
    const iat = parseUnixFlag(args['--iat']);
    const exp = parseUnixFlag(args['--exp']);
    if (nowFlag === null || iat === null || exp === null) return fail();
    const nowSeconds = nowFlag === undefined ? Math.floor(Date.now() / 1000) : nowFlag;
    if (!isUnixSeconds(nowSeconds)) return fail();

    const signed = signMandateProof({
      requestBody,
      privateKey,
      accountId,
      principalKid,
      environment,
      nowSeconds,
      nonce: args['--nonce'],
      iat,
      exp,
    });
    if (!signed.ok) return fail();
    const keys = Object.keys(signed.mandate_proof);
    if (keys.length !== PROOF_KEYS.length || PROOF_KEYS.some((key) => !keys.includes(key))) {
      return fail();
    }
    stdout.write(`${JSON.stringify(signed.mandate_proof)}\n`);
    return 0;
  } catch {
    return fail();
  }
}
