/**
 * Canonical Sentinel Verdict Body for External Anchoring
 * -------------------------------------------------------
 * Produces a deterministic, JCS-canonicalized (RFC 8785) JSON body from a
 * SentinelVerifyResponse, so a third party (e.g. invinoveritas) can hash it
 * as-is and anchor it — with the hash recomputable by anyone from the same
 * bytes.  This is the "recomputable proof" property: the anchored artifact is
 * byte-deterministic, not just structurally JSON.
 *
 * Design choices (mirrors thoughtproof-api-v2/verdict-canonical.ts):
 *  - Optional fields (gate, secondary model, v2 provenance) are OMITTED when
 *    not present, never null — JCS treats absent vs null distinctly.
 *  - Canonical serialization via JCS (RFC 8785) so body bytes are stable.
 *  - v1 is a strict projection of SentinelVerifyResponse — nothing added,
 *    nothing re-expressed.  "ThoughtProof said X" stays intact.
 *  - v2 (ADR-0022) is that projection plus optional releaseId, policy, and
 *    potCli, and optional salted mandateDigest / actionDigest. It does not
 *    change the verdict. Callers that cannot build v2 omit signed_export_v2.
 *    The commitment salt is not a v2 field.
 *
 * v1 is pure computation. v2 may read the installed pot-cli version; a throw
 * from that read propagates so the export issuer can omit signed_export_v2.
 * No network and no anchoring. Anchoring (EAS/Arweave/OTS) is the consumer's
 * responsibility.
 */
import { createHash } from 'crypto';
// `canonicalize` exposes a default export; the package ships no native ESM
// types for the default but the runtime call works in both CJS and ESM.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - canonicalize types are loose; runtime export is the function
import canonicalize from 'canonicalize';
import type { SentinelVerifyResponse } from './types.js';
import { confidenceToPercent } from './confidence.js';
import { getPotCliVersion, publishablePotCliVersion } from './runtime-versions.js';

/** Pinned v1 schema. External verifiers and m1-export vectors depend on these bytes. */
export const CANONICAL_VERDICT_SCHEMA_V1 = 'sentinel.verdict.canonical.v1' as const;

/** Additive superset schema (ADR-0022). Does not replace v1 during the transition. */
export const CANONICAL_VERDICT_SCHEMA_V2 = 'sentinel.verdict.canonical.v2' as const;

export const ACCEPTED_CANONICAL_VERDICT_SCHEMAS = [
  CANONICAL_VERDICT_SCHEMA_V1,
  CANONICAL_VERDICT_SCHEMA_V2,
] as const;

export type CanonicalVerdictSchema = (typeof ACCEPTED_CANONICAL_VERDICT_SCHEMAS)[number];

export function isAcceptedCanonicalVerdictSchema(
  value: unknown,
): value is CanonicalVerdictSchema {
  return value === CANONICAL_VERDICT_SCHEMA_V1 || value === CANONICAL_VERDICT_SCHEMA_V2;
}

/**
 * The canonical body shape.  Tagged with `artifactSchema` so consumers can
 * distinguish Sentinel verdicts from PLV verdicts or future formats.
 */
export interface CanonicalSentinelVerdictBody {
  /** Schema identity — distinguishes from plv.verdict.canonical.v1 etc. */
  artifactSchema: typeof CANONICAL_VERDICT_SCHEMA_V1;
  /** Stable verification id (matches response.id). */
  verificationId: string;
  /** API version (hardcoded for now; bump if the body shape changes). */
  apiVersion: string;
  /** Tier label (checkpoint | standard | swift | pro | swift-real). */
  tier: string;
  /** Verification mode (handoff | plan_revision | ... | action_authorization). */
  mode: string;
  /** Public verdict (ALLOW | BLOCK | UNCERTAIN). */
  verdict: string;
  /** 0-100 confidence (canonical form uses 0-100 int, response uses 0-1 float). */
  confidence: number;
  /** Material objections — the substance behind the verdict. */
  objections: string[];
  /** Human-readable reasoning. */
  reasoning: string;
  /** Unix seconds (from meta.verified_at ISO string). */
  evaluatedAt: number;
  /** Models that produced the verdict (from meta.models_used). */
  models: {
    primary: string;
    secondary?: string;
  };
  /** SHA256 hash of the bounded package (F1, omitted when absent). */
  packageDigest?: string;
  /** Proof strength (F1, omitted when absent). */
  proofStrength?: string;
  /** Deterministic-gate result (action_authorization only; omitted otherwise). */
  gate?: {
    mode: string;
    wouldBlock: boolean;
    enforced: boolean;
    violations: string[];
  };
}

/**
 * v2 body (ADR-0022): every v1 field, plus optional provenance and
 * optional salted commitments. The salt itself is not in this body.
 * releaseId ← meta.promotion.release_id
 * policy ← meta.promotion.policy
 * potCli ← publishable pot-cli semver (getPotCliVersion, or an explicit override)
 * mandateDigest / actionDigest ← sha256(salt || JCS(...)), caller-supplied
 * Absent fields are omitted, never null.
 */
export interface CanonicalSentinelVerdictBodyV2
  extends Omit<CanonicalSentinelVerdictBody, 'artifactSchema'> {
  artifactSchema: typeof CANONICAL_VERDICT_SCHEMA_V2;
  /** Git commit SHA from meta.promotion.release_id. Omitted when absent. */
  releaseId?: string;
  /** Promotion policy id from meta.promotion.policy. Omitted when absent. */
  policy?: string;
  /** Installed pot-cli semver. Omitted when missing or not a publishable semver. */
  potCli?: string;
  /**
   * sha256(salt || JCS(mandate)), `sha256:` + lowercase hex.
   * Omitted when the mandate is absent or hashing fails. Not a verdict input.
   */
  mandateDigest?: string;
  /**
   * sha256(salt || JCS(action)), same encoding as mandateDigest.
   * Omitted when the action is absent or hashing fails.
   */
  actionDigest?: string;
}

export type CanonicalSentinelVerdictArtifact =
  | CanonicalSentinelVerdictBody
  | CanonicalSentinelVerdictBodyV2;

export function isCanonicalSentinelVerdictBody(
  value: unknown,
): value is CanonicalSentinelVerdictArtifact {
  if (!value || typeof value !== 'object') return false;
  return isAcceptedCanonicalVerdictSchema(
    (value as { artifactSchema?: unknown }).artifactSchema,
  );
}

const COMMITMENT_DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface BuildCanonicalSentinelVerdictV2Options {
  /**
   * pot-cli version to commit. When omitted, the builder calls
   * getPotCliVersion() (a throw propagates). Non-semver values, including
   * `unavailable`, are omitted from the body.
   */
  potCli?: string;
  /**
   * Precomputed salted mandate commitment. A value that is not
   * `sha256:` + 64 lowercase hex chars is omitted. Never throws.
   */
  mandateDigest?: string;
  /** Precomputed salted action commitment. Same acceptance rule as mandateDigest. */
  actionDigest?: string;
}

/**
 * Build the canonical (pre-serialization) v1 body from a SentinelVerifyResponse.
 * Pure function — no I/O, no side effects. Does not read promotion provenance
 * or pot-cli; those belong to v2 only, so existing v1 bytes stay stable.
 */
export function buildCanonicalSentinelVerdict(
  response: SentinelVerifyResponse,
): CanonicalSentinelVerdictBody {
  const evaluatedAt = Math.floor(
    new Date(response.meta.verified_at).getTime() / 1000,
  );
  const confidence = confidenceToPercent(response.confidence);

  const modelsUsed = response.meta.models_used ?? [];
  const models: CanonicalSentinelVerdictBody['models'] = {
    primary: modelsUsed[0] ?? 'unknown',
  };
  if (modelsUsed.length > 1) {
    models.secondary = modelsUsed[1];
  }

  const body: CanonicalSentinelVerdictBody = {
    artifactSchema: CANONICAL_VERDICT_SCHEMA_V1,
    verificationId: response.id,
    apiVersion: 'sentinel-api-0.1.0',
    tier: response.tier,
    mode: response.mode,
    verdict: response.verdict,
    confidence,
    objections: (response.objections ?? []).map(
      (o) => `${o.step_id}: ${o.reasoning}`,
    ),
    reasoning: response.reasoning ?? '',
    evaluatedAt,
    models,
  };

  // package digest and proof strength are optional (F1) — only present when computed
  if (response.meta.package_digest) {
    body.packageDigest = response.meta.package_digest;
  }
  if (response.meta.proof_strength) {
    body.proofStrength = response.meta.proof_strength;
  }

  // gate is optional — only present for action_authorization with a mandate.
  // Omit entirely (not null) when absent, for JCS determinism.
  if (response.gate) {
    body.gate = {
      mode: response.gate.mode,
      wouldBlock: response.gate.wouldBlock,
      enforced: response.gate.enforced,
      violations: response.gate.violations.map((v) => v.detail),
    };
  }

  return body;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Build the v2 body. Starts from the v1 projection so shared fields cannot
 * drift, then adds provenance. Does not mutate the v1 body.
 * Throws if the pot-cli lookup throws — callers that issue signed_export_v2
 * must catch and omit the export. Never used to decide a verdict.
 */
export function buildCanonicalSentinelVerdictV2(
  response: SentinelVerifyResponse,
  options: BuildCanonicalSentinelVerdictV2Options = {},
): CanonicalSentinelVerdictBodyV2 {
  const v1 = buildCanonicalSentinelVerdict(response);
  const body: CanonicalSentinelVerdictBodyV2 = {
    ...v1,
    artifactSchema: CANONICAL_VERDICT_SCHEMA_V2,
  };

  const releaseId = nonEmptyString(response.meta.promotion?.release_id);
  if (releaseId) body.releaseId = releaseId;
  const policy = nonEmptyString(response.meta.promotion?.policy);
  if (policy) body.policy = policy;

  const potSource = options.potCli !== undefined ? options.potCli : getPotCliVersion();
  const potCli = publishablePotCliVersion(potSource);
  if (potCli) body.potCli = potCli;

  // Commitments are copied, not computed here. A bad string is omitted so a
  // digest failure cannot drop releaseId/policy/potCli or change the verdict.
  if (typeof options.mandateDigest === 'string' && COMMITMENT_DIGEST.test(options.mandateDigest)) {
    body.mandateDigest = options.mandateDigest;
  }
  if (typeof options.actionDigest === 'string' && COMMITMENT_DIGEST.test(options.actionDigest)) {
    body.actionDigest = options.actionDigest;
  }

  return body;
}

/**
 * Serialize a canonical body to its JCS (RFC 8785) byte form.
 * This is what gets hashed for anchoring.
 */
export function serializeCanonicalSentinelVerdict(
  body: CanonicalSentinelVerdictArtifact,
): string {
  const out = (canonicalize as unknown as (v: unknown) => string)(body);
  if (typeof out !== 'string') {
    throw new Error('canonicalize() did not return a string');
  }
  return out;
}

/**
 * Audit-side hash of the canonical body (sha256).
 * Recomputable: download the anchored bytes, canonicalize+hash again,
 * must equal this value.
 */
export function hashCanonicalSentinelVerdict(
  body: CanonicalSentinelVerdictArtifact,
): string {
  const serialized = serializeCanonicalSentinelVerdict(body);
  return `0x${createHash('sha256').update(serialized).digest('hex')}`;
}
