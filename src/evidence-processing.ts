/**
 * Evidence Processing and Verdict Effects (F1)
 * -----------------------------------------------
 * 
 * Processes signed evidence and applies verdict effects based on verification results.
 * Integrates with the verify handler to force verdict changes when evidence verification
 * fails for required items.
 */

import { verifySignedEvidence } from './signed-evidence.js';
import { computePackageDigest } from './package-digest.js';
import type {
  SentinelVerifyRequest,
  SentinelVerifyResponse,
  SentinelVerdict,
  EvidenceVerificationResult,
  SentinelStepObjection,
} from './types.js';

/**
 * Result of processing evidence items.
 */
export interface EvidenceProcessingResult {
  /** Whether any required evidence verification failed (forces verdict change) */
  shouldForceVerdict: boolean;
  /** Forced verdict when shouldForceVerdict is true */
  forcedVerdict?: SentinelVerdict;
  /** Additional objections from evidence verification failures */
  additionalObjections: SentinelStepObjection[];
  /** Per-evidence verification results for response metadata */
  evidenceVerification: EvidenceVerificationResult[];
  /** Proof strength indicator */
  proofStrength: 'recomputed' | 'supplied_evidence';
}

/**
 * Process signed evidence and determine verdict effects.
 * 
 * @param request The validated request
 * @returns Processing result with verdict effects
 */
export function processSignedEvidence(request: SentinelVerifyRequest): EvidenceProcessingResult {
  // If no signed evidence, return supplied evidence mode
  if (!request.signed_evidence || request.signed_evidence.length === 0) {
    return {
      shouldForceVerdict: false,
      additionalObjections: [],
      evidenceVerification: [],
      proofStrength: 'supplied_evidence',
    };
  }

  // Verify the evidence items
  const verificationResults = verifySignedEvidence(request.signed_evidence, request.key_manifest);
  
  // Convert to response format with indices
  const evidenceVerification: EvidenceVerificationResult[] = verificationResults.map((result, index) => ({
    index,
    status: result.status,
    severity: result.severity,
    code: result.code,
    reason: result.reason,
    signer: result.signer,
  }));

  // Check for required evidence failures — classification uses the STRUCTURED
  // severity/code from signed-evidence.ts, never string matching on reasons.
  const failedRequired: Array<{ index: number; code: string; reason: string }> = [];
  const uncertainRequired: Array<{ index: number; code: string; reason: string }> = [];
  let allRequiredRecomputed = true;

  for (let i = 0; i < request.signed_evidence.length; i++) {
    const evidence = request.signed_evidence[i];
    const result = verificationResults[i];

    if (evidence.verification === 'required') {
      if (result.status === 'failed') {
        const code = result.code ?? 'evidence_verification_error';
        const reason = result.reason ?? 'Evidence verification failed';
        if (result.severity === 'block') {
          failedRequired.push({ index: i, code, reason });
        } else {
          // 'uncertain' or missing severity (defensive default = uncertain,
          // never silently allow, never block on an unclassified verifier bug)
          uncertainRequired.push({ index: i, code, reason });
        }
        allRequiredRecomputed = false;
      } else if (result.status !== 'recomputed') {
        allRequiredRecomputed = false;
      }
    } else if (result.status !== 'recomputed') {
      allRequiredRecomputed = false;
    }
  }

  // Build additional objections
  const additionalObjections: SentinelStepObjection[] = [];

  for (const failed of failedRequired) {
    additionalObjections.push({
      step_id: `evidence_${failed.index}`,
      criterion: 'Cryptographic evidence verification',
      score: 0.0,
      predicate: 'unsupported',
      quote: null,
      reasoning: `${failed.code}:${failed.index} — Evidence signature verification failed: ${failed.reason}`,
    });
  }

  for (const uncertain of uncertainRequired) {
    additionalObjections.push({
      step_id: `evidence_${uncertain.index}`,
      criterion: 'Cryptographic evidence verification',
      score: 0.3,
      predicate: 'partial',
      quote: null,
      reasoning: `${uncertain.code}:${uncertain.index} — Evidence verification uncertain: ${uncertain.reason}`,
    });
  }

  // Determine verdict forcing
  let shouldForceVerdict = false;
  let forcedVerdict: SentinelVerdict | undefined;

  if (failedRequired.length > 0) {
    shouldForceVerdict = true;
    forcedVerdict = 'BLOCK';
  } else if (uncertainRequired.length > 0) {
    // Only downgrade to UNCERTAIN, never upgrade from BLOCK/UNCERTAIN
    shouldForceVerdict = true;
    forcedVerdict = 'UNCERTAIN';
  }

  // Determine proof strength
  const proofStrength: 'recomputed' | 'supplied_evidence' = allRequiredRecomputed ? 'recomputed' : 'supplied_evidence';

  return {
    shouldForceVerdict,
    forcedVerdict,
    additionalObjections,
    evidenceVerification,
    proofStrength,
  };
}

/**
 * Apply evidence processing results to a response.
 * 
 * @param response The response from the engine
 * @param processingResult The evidence processing result
 * @param request The original request (for package digest)
 * @returns Modified response with evidence effects applied
 */
export function applyEvidenceEffects(
  response: SentinelVerifyResponse,
  processingResult: EvidenceProcessingResult,
  request: SentinelVerifyRequest,
): SentinelVerifyResponse {
  const hasSignedEvidence = !!(request.signed_evidence && request.signed_evidence.length > 0);

  // Compute package digest.
  // Failure handling (C3): when signed evidence is present, an uncomputable
  // digest means the verdict cannot be bound to the package → force UNCERTAIN.
  // Without signed evidence the digest is optional metadata; failure is silent
  // (digest computation on a validated request should not fail in practice).
  let packageDigest: string | undefined;
  let digestFailed = false;
  try {
    packageDigest = computePackageDigest(request);
  } catch (error) {
    console.error('[evidence-processing] failed to compute package digest:', error);
    digestFailed = true;
  }

  // Apply verdict forcing
  let finalVerdict = response.verdict;
  let finalReasoning = response.reasoning;
  let finalObjections = [...(response.objections || [])];

  if (processingResult.shouldForceVerdict && processingResult.forcedVerdict) {
    // For BLOCK, always override
    if (processingResult.forcedVerdict === 'BLOCK') {
      finalVerdict = 'BLOCK';
      finalReasoning = `Evidence verification failed. Original reasoning: ${response.reasoning}`;
    }
    // For UNCERTAIN, only downgrade from ALLOW
    else if (processingResult.forcedVerdict === 'UNCERTAIN' && response.verdict === 'ALLOW') {
      finalVerdict = 'UNCERTAIN';
      finalReasoning = `Evidence verification issues detected. Original reasoning: ${response.reasoning}`;
    }
  }

  // Digest failure with signed evidence present: downgrade ALLOW → UNCERTAIN.
  if (digestFailed && hasSignedEvidence && finalVerdict === 'ALLOW') {
    finalVerdict = 'UNCERTAIN';
    finalReasoning = `Package digest could not be computed; verdict is not action-bound. Original reasoning: ${response.reasoning}`;
    finalObjections.push({
      step_id: 'package_digest',
      criterion: 'Action-bound verification',
      score: 0.3,
      predicate: 'partial',
      quote: null,
      reasoning: 'package_digest_uncomputable — verdict could not be bound to the exact request package',
    });
  }

  // Add evidence objections
  finalObjections.push(...processingResult.additionalObjections);

  // F1 meta fields are only attached when signed evidence was actually part of
  // the request (C2): requests WITHOUT signed_evidence must produce a response
  // shape byte-identical to pre-F1 behavior (backward compatibility), and the
  // canonical verdict body (which third parties hash) must not gain fields.
  const modifiedResponse: SentinelVerifyResponse = {
    ...response,
    verdict: finalVerdict,
    reasoning: finalReasoning,
    objections: finalObjections,
    meta: {
      ...response.meta,
      ...(hasSignedEvidence && packageDigest ? { package_digest: packageDigest } : {}),
      ...(processingResult.evidenceVerification.length > 0 ? {
        evidence_verification: processingResult.evidenceVerification,
      } : {}),
      ...(hasSignedEvidence ? { proof_strength: processingResult.proofStrength } : {}),
    },
  };

  return modifiedResponse;
}