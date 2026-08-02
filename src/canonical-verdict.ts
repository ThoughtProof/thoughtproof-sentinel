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
 *  - Optional fields (gate, secondary model) are OMITTED when not present,
 *    never null — JCS treats absent vs null distinctly.
 *  - Canonical serialization via JCS (RFC 8785) so body bytes are stable.
 *  - The body is a strict projection of SentinelVerifyResponse — nothing
 *    added, nothing re-expressed.  "ThoughtProof said X" stays intact.
 *
 * This module is PURE COMPUTATION — no I/O, no network, no anchoring.
 * The anchoring (EAS/Arweave/OTS) is the consumer's responsibility.
 */
import { createHash } from 'crypto';
// `canonicalize` exposes a default export; the package ships no native ESM
// types for the default but the runtime call works in both CJS and ESM.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - canonicalize types are loose; runtime export is the function
import canonicalize from 'canonicalize';
import type { SentinelVerifyResponse } from './types.js';

/**
 * The canonical body shape.  Tagged with `artifactSchema` so consumers can
 * distinguish Sentinel verdicts from PLV verdicts or future formats.
 */
export interface CanonicalSentinelVerdictBody {
  /** Schema identity — distinguishes from plv.verdict.canonical.v1 etc. */
  artifactSchema: 'sentinel.verdict.canonical.v1';
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
 * Build the canonical (pre-serialization) body from a SentinelVerifyResponse.
 * Pure function — no I/O, no side effects.
 */
export function buildCanonicalSentinelVerdict(
  response: SentinelVerifyResponse,
): CanonicalSentinelVerdictBody {
  const evaluatedAt = Math.floor(
    new Date(response.meta.verified_at).getTime() / 1000,
  );
  const confidence = Math.max(
    0,
    Math.min(100, Math.round(response.confidence * 100)),
  );

  const modelsUsed = response.meta.models_used ?? [];
  const models: CanonicalSentinelVerdictBody['models'] = {
    primary: modelsUsed[0] ?? 'unknown',
  };
  if (modelsUsed.length > 1) {
    models.secondary = modelsUsed[1];
  }

  const body: CanonicalSentinelVerdictBody = {
    artifactSchema: 'sentinel.verdict.canonical.v1',
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

/**
 * Serialize a canonical body to its JCS (RFC 8785) byte form.
 * This is what gets hashed for anchoring.
 */
export function serializeCanonicalSentinelVerdict(
  body: CanonicalSentinelVerdictBody,
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
  body: CanonicalSentinelVerdictBody,
): string {
  const serialized = serializeCanonicalSentinelVerdict(body);
  return `0x${createHash('sha256').update(serialized).digest('hex')}`;
}
