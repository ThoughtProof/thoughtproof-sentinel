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
    reason: result.reason,
    signer: result.signer,
  }));

  // Check for required evidence failures
  const failedRequired: Array<{ index: number; reason: string }> = [];
  const uncertainRequired: Array<{ index: number; reason: string }> = [];
  let allRequiredRecomputed = true;

  for (let i = 0; i < request.signed_evidence.length; i++) {
    const evidence = request.signed_evidence[i];
    const result = verificationResults[i];

    if (evidence.verification === 'required') {
      if (result.status === 'failed') {
        // Determine if this is a BLOCK or UNCERTAIN failure
        const isCriticalFailure = result.reason?.includes('Invalid signature') ||
                                  result.reason?.includes('revoked') ||
                                  result.reason?.includes('not authorized') ||
                                  result.reason?.includes('Unsupported signature scheme');
          
        if (isCriticalFailure) {
          failedRequired.push({ index: i, reason: result.reason || 'Evidence verification failed' });
        } else {
          uncertainRequired.push({ index: i, reason: result.reason || 'Evidence verification uncertain' });
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
      reasoning: `Evidence signature verification failed: ${failed.reason}`,
    });
  }

  for (const uncertain of uncertainRequired) {
    additionalObjections.push({
      step_id: `evidence_${uncertain.index}`,
      criterion: 'Cryptographic evidence verification',
      score: 0.3,
      predicate: 'partial',
      quote: null,
      reasoning: `Evidence verification uncertain: ${uncertain.reason}`,
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
  // Compute package digest
  let packageDigest: string | undefined;
  try {
    packageDigest = computePackageDigest(request);
  } catch (error) {
    console.error('[evidence-processing] failed to compute package digest:', error);
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

  // Add evidence objections
  finalObjections.push(...processingResult.additionalObjections);

  // Build the modified response
  const modifiedResponse: SentinelVerifyResponse = {
    ...response,
    verdict: finalVerdict,
    reasoning: finalReasoning,
    objections: finalObjections,
    meta: {
      ...response.meta,
      ...(packageDigest ? { package_digest: packageDigest } : {}),
      ...(processingResult.evidenceVerification.length > 0 ? {
        evidence_verification: processingResult.evidenceVerification,
      } : {}),
      proof_strength: processingResult.proofStrength,
    },
  };

  return modifiedResponse;
}