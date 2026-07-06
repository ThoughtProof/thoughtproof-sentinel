// Canonical Sentinel verdict body — the byte-deterministic artifact ThoughtProof
// hands to invinoveritas for anchoring in the composed-evaluators/verdict-envelope
// composition. A third party can recompute sha256 over the JCS (RFC 8785)
// serialization of this body and match the anchored body_hash WITHOUT trusting
// either party.
//
// Schema (source of truth for shape): verdict-envelope/schemas/
//   sentinel.verdict.canonical.v1.schema.json
//
// JCS DETERMINISM RULES (load-bearing — a stray null or key reorder breaks the
// hash and the whole separable-attribution property):
//   - Optional fields (models.secondary, gate) are OMITTED ENTIRELY when absent,
//     never set to null. JCS treats absent vs null distinctly.
//   - confidence is a 0-100 integer here (the live API carries a 0-1 float).
//   - Serialize with RFC 8785 JCS, then sha256.

import canonicalize from "canonicalize";
import { createHash } from "node:crypto";
import type { SentinelVerifyResponse } from "./types.js";

export const CANONICAL_ARTIFACT_SCHEMA = "sentinel.verdict.canonical.v1";
/** Sentinel API body-shape version. Bump only if the canonical body shape changes. */
export const CANONICAL_API_VERSION = "sentinel-api-0.1.0";

export interface CanonicalSentinelVerdict {
  artifactSchema: typeof CANONICAL_ARTIFACT_SCHEMA;
  verificationId: string;
  apiVersion: string;
  tier: string;
  mode: string;
  verdict: "ALLOW" | "BLOCK" | "UNCERTAIN";
  confidence: number; // 0-100 integer
  objections: string[];
  reasoning: string;
  evaluatedAt: number; // unix seconds
  models: { primary: string; secondary?: string };
  gate?: {
    mode: string;
    wouldBlock: boolean;
    enforced: boolean;
    violations: string[];
  };
}

/**
 * Project a live Sentinel verify response into the canonical, byte-deterministic
 * body. Pure and deterministic: same response in → same object out (and thus the
 * same JCS bytes and hash).
 */
export function buildCanonicalSentinelVerdict(
  resp: SentinelVerifyResponse,
  apiVersion: string = CANONICAL_API_VERSION,
): CanonicalSentinelVerdict {
  // confidence: 0-1 float → 0-100 int, clamped.
  // ROUNDING RULE (must match any independent recomputation): round-half-up via
  // Math.round (JS: 0.845*100=84.5→85; .5 always rounds toward +Inf). A partner
  // recomputing the body_hash MUST use the same rule or .5-boundary values diverge.
  const confidence = Math.max(0, Math.min(100, Math.round(resp.confidence * 100)));

  // objections: deterministic "${step_id}: ${reasoning}" mapping, in response order.
  const objections = (resp.objections ?? []).map(
    (o) => `${o.step_id}: ${o.reasoning}`,
  );

  // evaluatedAt: floor(Date(meta.verified_at)/1000) → unix seconds.
  const evaluatedAt = Math.floor(new Date(resp.meta.verified_at).getTime() / 1000);

  // models: primary always; secondary only if the cascade escalated to a 2nd
  // distinct model. OMITTED ENTIRELY otherwise (never null).
  const used = resp.meta.models_used ?? [];
  const models: CanonicalSentinelVerdict["models"] = { primary: used[0] ?? "" };
  if (used.length > 1 && used[1] && used[1] !== used[0]) {
    models.secondary = used[1];
  }

  const body: CanonicalSentinelVerdict = {
    artifactSchema: CANONICAL_ARTIFACT_SCHEMA,
    verificationId: resp.id,
    apiVersion,
    tier: resp.tier,
    mode: resp.mode,
    verdict: resp.verdict,
    confidence,
    objections,
    reasoning: resp.reasoning ?? "",
    evaluatedAt,
    models,
  };

  // gate: present ONLY for action_authorization with a machine-readable mandate.
  // OMITTED ENTIRELY otherwise (never null).
  if (resp.gate) {
    body.gate = {
      mode: resp.gate.mode,
      wouldBlock: resp.gate.wouldBlock,
      enforced: resp.gate.enforced,
      // GateViolation is { kind, detail }; map deterministically to
      // "${kind}: ${detail}" (same shape rule as objections).
      violations: (resp.gate.violations ?? []).map((v) => `${v.kind}: ${v.detail}`),
    };
  }

  return body;
}

/**
 * JCS-serialize (RFC 8785) the canonical body to the exact bytes that get
 * hashed and handed to /witness. `canonicalize` sorts keys and strips
 * insignificant whitespace deterministically.
 */
export function canonicalizeVerdict(body: CanonicalSentinelVerdict): string {
  const jcs = canonicalize(body);
  if (typeof jcs !== "string") {
    throw new Error("JCS canonicalization returned non-string");
  }
  return jcs;
}

/** sha256 hex over the JCS bytes — this is the anchored body_hash (without 0x). */
export function verdictBodyHash(body: CanonicalSentinelVerdict): string {
  return createHash("sha256").update(canonicalizeVerdict(body), "utf8").digest("hex");
}

/** Convenience: response → { body, jcs, bodyHash } in one call. */
export function composeCanonicalArtifact(
  resp: SentinelVerifyResponse,
  apiVersion: string = CANONICAL_API_VERSION,
): { body: CanonicalSentinelVerdict; jcs: string; bodyHash: string } {
  const body = buildCanonicalSentinelVerdict(resp, apiVersion);
  const jcs = canonicalizeVerdict(body);
  const bodyHash = createHash("sha256").update(jcs, "utf8").digest("hex");
  return { body, jcs, bodyHash };
}
