#!/usr/bin/env node
/**
 * Portable Receipt Verifier (F1 action-bound verification)
 * ---------------------------------------------------------
 * 
 * Zero-dependency script to verify ThoughtProof Sentinel receipts offline.
 * Recomputes package digests and checks evidence verification statuses.
 * 
 * Usage:
 *   node verify-receipt.mjs <receipt.json> [original-request.json]
 *   
 * If original-request.json is provided, recomputes and verifies the package digest.
 * Otherwise, displays the evidence verification information from the receipt.
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';

/**
 * JCS canonicalization (RFC 8785) - simple recursive key sorting.
 * Must match the server-side canonicalization exactly.
 */
function canonicalize(obj) {
  if (Array.isArray(obj)) {
    return obj.map(canonicalize);
  }
  
  if (obj && typeof obj === 'object') {
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] !== undefined) {
        sorted[key] = canonicalize(obj[key]);
      }
    }
    return sorted;
  }
  
  return obj;
}

/**
 * Remove undefined fields recursively for deterministic serialization.
 */
function removeUndefinedFields(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(removeUndefinedFields);
  }
  
  if (typeof obj === 'object') {
    const cleaned = {};
    
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        cleaned[key] = removeUndefinedFields(value);
      }
    }
    
    return cleaned;
  }
  
  return obj;
}

/**
 * Compute package digest from a request object.
 */
function computePackageDigest(request) {
  const cleanRequest = removeUndefinedFields(request);
  const canonical = JSON.stringify(canonicalize(cleanRequest));
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * Display evidence verification information.
 */
function displayEvidenceInfo(receipt) {
  const evidence = receipt.meta?.evidence_verification;
  const proofStrength = receipt.meta?.proof_strength;
  const packageDigest = receipt.meta?.package_digest;
  
  console.log('=== F1 Action-Bound Verification Info ===');
  console.log(`Proof Strength: ${proofStrength || 'not available'}`);
  console.log(`Package Digest: ${packageDigest || 'not available'}`);
  
  if (evidence && evidence.length > 0) {
    console.log('\\nEvidence Verification Results:');
    for (const item of evidence) {
      console.log(`  [${item.index}] Status: ${item.status}`);
      if (item.reason) {
        console.log(`      Reason: ${item.reason}`);
      }
      if (item.signer) {
        console.log(`      Signer: ${item.signer}`);
      }
    }
  } else {
    console.log('\\nNo signed evidence was processed.');
  }
}

/**
 * Verify package digest against request.
 */
function verifyDigestMatch(receipt, request) {
  const expectedDigest = receipt.meta?.package_digest;
  
  if (!expectedDigest) {
    console.log('❌ No package digest in receipt to verify');
    return false;
  }
  
  if (!expectedDigest.startsWith('sha256:')) {
    console.log('❌ Invalid digest format (expected sha256:...)');
    return false;
  }
  
  try {
    const computedDigest = computePackageDigest(request);
    const match = computedDigest === expectedDigest;
    
    console.log(`Expected digest: ${expectedDigest}`);
    console.log(`Computed digest: ${computedDigest}`);
    console.log(`${match ? '✅' : '❌'} Package digest ${match ? 'matches' : 'does not match'}`);
    
    if (!match) {
      console.log('');
      console.log('Hint: as of F3, the /verify endpoint rejects unknown fields');
      console.log('with HTTP 400 rather than silently dropping them. If this receipt');
      console.log('was produced by a pre-F3 server, an unknown field in the original');
      console.log('request may have been silently stripped before digest computation.');
      console.log('Check the request shape against the OpenAPI spec.');
    }
    
    return match;
  } catch (error) {
    console.log(`❌ Failed to compute package digest: ${error.message}`);
    return false;
  }
}

async function main() {
  const receiptPath = process.argv[2];
  const requestPath = process.argv[3];
  
  if (!receiptPath) {
    console.error('Usage: node verify-receipt.mjs <receipt.json> [original-request.json]');
    process.exit(1);
  }
  
  try {
    // Load receipt
    const receiptJson = readFileSync(receiptPath, 'utf8');
    const receipt = JSON.parse(receiptJson);
    
    console.log(`Verification ID: ${receipt.id}`);
    console.log(`Verdict: ${receipt.verdict}`);
    console.log(`Confidence: ${receipt.confidence}`);
    console.log(`Tier: ${receipt.tier}`);
    console.log(`Mode: ${receipt.mode}`);
    
    // Display evidence information
    displayEvidenceInfo(receipt);
    
    // If request provided, verify digest
    let digestMatch = true;
    if (requestPath) {
      console.log('\\n=== Package Digest Verification ===');
      try {
        const requestJson = readFileSync(requestPath, 'utf8');
        const request = JSON.parse(requestJson);
        digestMatch = verifyDigestMatch(receipt, request);
      } catch (error) {
        console.log(`❌ Failed to load request file: ${error.message}`);
        digestMatch = false;
      }
    } else {
      console.log('\\n💡 Provide original request file to verify package digest');
    }
    
    // Overall result
    console.log('\\n=== Overall Verification ===');
    const proofStrength = receipt.meta?.proof_strength;
    const hasEvidence = receipt.meta?.evidence_verification?.length > 0;
    
    if (hasEvidence && proofStrength === 'recomputed') {
      console.log('✅ Receipt contains recomputed cryptographic evidence');
    } else if (hasEvidence && proofStrength === 'unverified') {
      console.log('⚠️  Receipt contains unverified evidence (verifier could not independently recompute)');
    } else {
      console.log('ℹ️  Receipt contains no cryptographic evidence (standard verification)');
    }
    
    if (requestPath) {
      console.log(`${digestMatch ? '✅' : '❌'} Package digest verification ${digestMatch ? 'passed' : 'failed'}`);
    }
    
    // Exit code: 0 if all checks pass, 1 if any fail
    const allGood = digestMatch && (!hasEvidence || proofStrength === 'recomputed' || 
                                   receipt.meta?.evidence_verification?.every(e => e.status === 'recomputed'));
    process.exit(allGood ? 0 : 1);
    
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(2);
});