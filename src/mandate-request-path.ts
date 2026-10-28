/**
 * ADR-0023 stage 4: request-path wiring for a principal-signed mandate.
 * Enforcement is off unless SENTINEL_MANDATE_PROOF_ENFORCE is exactly
 * `true`. While it is off, callers must not invoke the evaluator.
 *
 * A verified signature is a precondition. It lets the existing gates run.
 * It is not ALLOW, and it does not upgrade a verdict to ALLOW.
 * Registration stays locked: this module does not write a key.
 */

import { mapAuthenticatedPrincipalToAccount } from './mandate-account-migration.js';
import {
  normalizeMandate,
  verdictWithMandateNormalization,
  type MandateNormalizeResult,
  type NormalizedMandate,
} from './mandate-normalize.js';
import {
  decideNoAuthMandatePath,
  stage4UnavailablePayload,
  type Stage4UnavailableBody,
  type Stage4UnavailableCode,
} from './mandate-no-auth.js';
import {
  parseMandateProofSignature,
  stage4TransportAccepts,
} from './mandate-proof-signature.js';
import {
  consumeMandateNonce,
  type MandateReplayCommand,
} from './mandate-replay-store.js';
import {
  verdictWithPrincipalCheck,
  verifyPrincipalMandate,
  type PrincipalMandateResult,
  type PrincipalManifestStore,
} from './principal-key-manifest.js';

export const MANDATE_PROOF_ENFORCE_ENV = 'SENTINEL_MANDATE_PROOF_ENFORCE';

/** Attached to a request by tests. Production requests do not carry it. */
export const MANDATE_REQUEST_DEPS: unique symbol = Symbol.for(
  'thoughtproof.sentinel.mandateRequestDeps',
);

export type MandateAccountPolicy = 'protected' | 'legacy' | 'unreadable';

export interface MandateRequestDeps {
  nowSeconds: () => number;
  /** Missing, thrown, or any other value is unreadable. Never an implicit legacy. */
  readPolicy: (accountId: string) => MandateAccountPolicy;
  manifestStore: PrincipalManifestStore | null;
  /**
   * Omit to use the dedicated replay client.
   * `null` is an unavailable store (HTTP 503), not an in-memory pass.
   */
  replayCommand?: MandateReplayCommand | null;
  /** Trusted server target. Not read from the proof. */
  targetEnvironment?: string;
  env?: Record<string, unknown>;
  /** Test seam. Production uses the strict normalizer. */
  normalize?: (input: unknown) => MandateNormalizeResult;
}

export function mandateProofEnforceEnabled(
  env: Record<string, unknown> = process.env,
): boolean {
  return env[MANDATE_PROOF_ENFORCE_ENV] === 'true';
}

export function defaultMandateRequestDeps(
  env: Record<string, unknown> = process.env,
): MandateRequestDeps {
  const target = env.SENTINEL_MANDATE_TARGET_ENVIRONMENT;
  return {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    readPolicy: () => 'unreadable',
    manifestStore: null,
    targetEnvironment: typeof target === 'string' ? target : undefined,
    env,
  };
}

export function mandateRequestDeps(req: object): MandateRequestDeps {
  const attached = (req as { [MANDATE_REQUEST_DEPS]?: MandateRequestDeps })[MANDATE_REQUEST_DEPS];
  if (attached && typeof attached.readPolicy === 'function' && typeof attached.nowSeconds === 'function') {
    return attached;
  }
  return defaultMandateRequestDeps();
}

export interface MandateBlockBody {
  verdict: 'BLOCK';
  code: 'MANDATE_PROOF_INVALID';
  reason: string;
  request_id: string;
}

export interface MandateVerifiedContinuation {
  mandateSource: 'principal_signed';
  normalizedMandate: NormalizedMandate;
  principal: Extract<PrincipalMandateResult, { ok: true }>;
  normalization: Extract<MandateNormalizeResult, { ok: true }>;
}

export type MandatePathDecision =
  | { action: 'unavailable'; status: 503; body: Stage4UnavailableBody }
  | { action: 'block'; status: 200; body: MandateBlockBody }
  | { action: 'continue'; verified?: MandateVerifiedContinuation }
  /**
   * The account mapper refused a key that is not in the server record.
   * That stays the auth layer's 401. It is not ACCOUNT_UNAVAILABLE and
   * not ALLOW.
   */
  | { action: 'unauthorized' };

export interface MandateRequestInput {
  /** True only when SENTINEL_AUTH_REQUIRED is exactly `true`. */
  authRequired: boolean;
  /** Header value. Compared to the server key record. Never logged. */
  apiKey: string;
  /** From validateApiKey. Ignored when auth is not required. */
  accountIdFromAuth: string | undefined;
  /** Ignored as an account id. */
  agentIdHeader?: unknown;
  body: unknown;
  requestId: string;
  deps?: MandateRequestDeps;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function unavailable(requestId: string, code: Stage4UnavailableCode): MandatePathDecision {
  return {
    action: 'unavailable',
    status: 503,
    body: stage4UnavailablePayload({ code, requestId }),
  };
}

function block(requestId: string, reason: string): MandatePathDecision {
  return {
    action: 'block',
    status: 200,
    body: {
      verdict: 'BLOCK',
      code: 'MANDATE_PROOF_INVALID',
      reason,
      request_id: requestId,
    },
  };
}

function readPolicy(deps: MandateRequestDeps, accountId: string): MandateAccountPolicy {
  try {
    const status = deps.readPolicy(accountId);
    if (status === 'protected' || status === 'legacy') return status;
    return 'unreadable';
  } catch {
    return 'unreadable';
  }
}

function proofOnBody(body: unknown): { present: boolean; proof: unknown; mandate: unknown } {
  if (!isPlainObject(body) || !Object.prototype.hasOwnProperty.call(body, 'mandate_proof')) {
    return { present: false, proof: undefined, mandate: undefined };
  }
  return { present: true, proof: body.mandate_proof, mandate: body.mandate };
}

/**
 * Drop `mandate_proof` before the legacy validator so a flag-on request
 * is not rejected as an unknown field. Flag-off callers must not use this:
 * the field stays unknown and the validator still rejects it.
 */
export function bodyWithoutMandateProof(body: unknown): unknown {
  if (!isPlainObject(body) || !Object.prototype.hasOwnProperty.call(body, 'mandate_proof')) {
    return body;
  }
  const copy = { ...body };
  delete copy.mandate_proof;
  return copy;
}

interface VerifiedProof {
  principal: Extract<PrincipalMandateResult, { ok: true }>;
  normalization: Extract<MandateNormalizeResult, { ok: true }>;
  nonce: string;
  iat: number;
  exp: number;
}

type ProofCheck =
  | { kind: 'block'; reason: string }
  | { kind: 'unavailable'; code: Stage4UnavailableCode }
  | { kind: 'verified'; proof: VerifiedProof };

function bindingFromProof(proof: unknown): { nonce: string; iat: number; exp: number } | null {
  if (!isPlainObject(proof)) return null;
  const { nonce, iat, exp } = proof;
  if (typeof nonce !== 'string' || nonce.length === 0) return null;
  if (typeof iat !== 'number' || !Number.isSafeInteger(iat) || iat < 0) return null;
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp < 0) return null;
  return { nonce, iat, exp };
}

async function checkExplicitProof(
  input: MandateRequestInput,
  deps: MandateRequestDeps,
  accountId: string,
  mandate: unknown,
  proof: unknown,
): Promise<ProofCheck> {
  const normalize = deps.normalize ?? normalizeMandate;
  const normalization = normalize(mandate);
  if (!normalization.ok) return { kind: 'block', reason: normalization.reason };

  const signature = isPlainObject(proof) ? parseMandateProofSignature(proof.signature) : parseMandateProofSignature(undefined);
  if (!stage4TransportAccepts(normalization, signature) || !signature.ok) {
    return { kind: 'block', reason: 'malformed_signature' };
  }

  let nowSeconds: number;
  try {
    nowSeconds = deps.nowSeconds();
  } catch {
    return { kind: 'unavailable', code: 'RECEIPT_TIME_UNUSABLE' };
  }

  const principal = await verifyPrincipalMandate({
    authenticatedAccountId: accountId,
    mandate: normalization.mandate,
    mandateProof: proof,
    nowSeconds,
    store: deps.manifestStore,
    targetEnvironment: deps.targetEnvironment,
  });
  if (!principal.ok) {
    if ('httpStatus' in principal) return { kind: 'unavailable', code: principal.code };
    return { kind: 'block', reason: principal.reason };
  }

  const binding = bindingFromProof(proof);
  if (!binding) return { kind: 'unavailable', code: 'MANIFEST_MALFORMED' };
  return { kind: 'verified', proof: { principal, normalization, ...binding } };
}

async function resolveAccount(
  input: MandateRequestInput,
  deps: MandateRequestDeps,
  proofPresent: boolean,
): Promise<{ ok: true; accountId: string } | { ok: false; decision: MandatePathDecision }> {
  if (!input.authRequired) {
    const decision = decideNoAuthMandatePath({
      authenticatedAccountId: input.accountIdFromAuth,
      mandateProofPresent: proofPresent,
      signatureVerified: false,
      concreteAction: false,
    });
    if (decision.applies) {
      return { ok: false, decision: unavailable(input.requestId, decision.code) };
    }
    // Auth is off. A non-blank id on this input was not established by
    // the key check and must not become an account.
    return { ok: false, decision: unavailable(input.requestId, 'ACCOUNT_UNAVAILABLE') };
  }

  const requestAccountId = isPlainObject(input.body) && typeof input.body.account_id === 'string'
    ? input.body.account_id
    : undefined;
  const agentIdHeader = typeof input.agentIdHeader === 'string' ? input.agentIdHeader : undefined;
  const mapped = mapAuthenticatedPrincipalToAccount({
    principal: { authenticated: true, apiKey: input.apiKey },
    env: deps.env,
    requestAccountId,
    agentIdHeader,
  });
  if ('httpStatus' in mapped) {
    return { ok: false, decision: unavailable(input.requestId, mapped.code) };
  }
  if (!('ok' in mapped) || mapped.ok !== true) {
    return { ok: false, decision: { action: 'unauthorized' } };
  }

  const noAuth = decideNoAuthMandatePath({
    authenticatedAccountId: mapped.accountId,
    mandateProofPresent: proofPresent,
    signatureVerified: false,
    concreteAction: false,
  });
  if (noAuth.applies) {
    return { ok: false, decision: unavailable(input.requestId, noAuth.code) };
  }
  return { ok: true, accountId: mapped.accountId };
}

/**
 * Run the mandate precondition. Does not call the engine, the payment
 * gate, attestation, or billing. Does not return ALLOW.
 */
export async function evaluateMandateRequestPath(
  input: MandateRequestInput,
): Promise<MandatePathDecision> {
  const deps = input.deps ?? defaultMandateRequestDeps();
  try {
    const proof = proofOnBody(input.body);
    const account = await resolveAccount(input, deps, proof.present);
    if (!account.ok) return account.decision;

    if (!proof.present) {
      const policy = readPolicy(deps, account.accountId);
      if (policy === 'legacy') return { action: 'continue' };
      if (policy === 'protected') return block(input.requestId, 'mandate_proof_required');
      return unavailable(input.requestId, 'POLICY_UNAVAILABLE');
    }

    const checked = await checkExplicitProof(input, deps, account.accountId, proof.mandate, proof.proof);
    if (checked.kind === 'block') return block(input.requestId, checked.reason);
    if (checked.kind === 'unavailable') return unavailable(input.requestId, checked.code);

    const policy = readPolicy(deps, account.accountId);
    if (policy !== 'legacy' && policy !== 'protected') {
      return unavailable(input.requestId, 'POLICY_UNAVAILABLE');
    }

    const replay = await consumeMandateNonce(
      {
        accountId: account.accountId,
        nonce: checked.proof.nonce,
        iat: checked.proof.iat,
        exp: checked.proof.exp,
      },
      deps.replayCommand,
    );
    if (!replay.ok) {
      if ('httpStatus' in replay) return unavailable(input.requestId, replay.code);
      return block(input.requestId, replay.reason);
    }

    return {
      action: 'continue',
      verified: {
        mandateSource: 'principal_signed',
        normalizedMandate: checked.proof.normalization.mandate,
        principal: checked.proof.principal,
        normalization: checked.proof.normalization,
      },
    };
  } catch {
    return unavailable(input.requestId, 'MANIFEST_UNAVAILABLE');
  }
}

/**
 * Fold a verified principal check into the gate verdict.
 * BLOCK stays BLOCK. UNCERTAIN stays UNCERTAIN. ALLOW stays ALLOW.
 * A failed check cannot become ALLOW. The signature flag is not an upgrade.
 */
export function verdictAfterVerifiedMandate(
  gateVerdict: 'ALLOW' | 'BLOCK' | 'UNCERTAIN',
  verified: MandateVerifiedContinuation,
): 'ALLOW' | 'BLOCK' | 'UNCERTAIN' {
  return verdictWithMandateNormalization(
    verdictWithPrincipalCheck(gateVerdict, verified.principal),
    verified.normalization,
    true,
  );
}
