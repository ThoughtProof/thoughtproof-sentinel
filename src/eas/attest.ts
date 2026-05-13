/**
 * Sentinel EAS Attestation Service
 *
 * Issues on-chain attestations to Base Mainnet via EAS (Ethereum Attestation Service).
 * Uses the sentinel_qualified schema (0x3945d7...8d2b).
 *
 * This module is intentionally separate from the engine — attestation is a
 * post-verification side-effect, not part of core verification logic.
 *
 * Requires ATTESTER_PRIVATE_KEY env var for signing transactions.
 */

import { ethers } from 'ethers';
import { SENTINEL_EAS_CONFIG } from '../eas-config.js';
import type { AttestationData, AttestationResult, SentinelVerifyResponse, SentinelVerifyRequest } from '../types.js';

// EAS contract ABI — only the attest function we need
const EAS_ABI = [
  'function attest((bytes32 schema, (address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint256 value) data)) external payable returns (bytes32)',
];

// ABI encoder for schema fields
const SCHEMA_ENCODER = new ethers.AbiCoder();
const SCHEMA_TYPES = [
  'string',   // verificationId
  'bool',     // qualified
  'string',   // qualification
  'string',   // apiVersion
  'string',   // tier
  'string',   // mode
  'string',   // verdict
  'uint8',    // confidence (0-100)
  'bytes32',  // claimHash
  'bytes32',  // evidenceHash
  'uint64',   // evaluatedAt
];

/**
 * Hash a string to bytes32 using keccak256.
 * Used for claimHash and evidenceHash — on-chain fingerprint of inputs.
 */
export function hashToBytes32(input: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(input));
}

/**
 * Build AttestationData from a verification request + response pair.
 * Pure function — no I/O.
 */
export function buildAttestationData(
  req: SentinelVerifyRequest,
  res: SentinelVerifyResponse,
): AttestationData {
  return {
    verificationId: res.id,
    qualified: res.verdict === 'ALLOW',
    qualification: 'sentinel_qualified',
    apiVersion: '0.1.0',
    tier: res.tier,
    mode: res.mode,
    verdict: res.verdict,
    confidence: Math.round(res.confidence * 100), // 0-100 for uint8
    claimHash: hashToBytes32(req.claim),
    evidenceHash: hashToBytes32(req.evidence),
    evaluatedAt: Math.floor(new Date(res.meta.verified_at).getTime() / 1000),
  };
}

/**
 * Encode attestation data into ABI-encoded bytes for the EAS schema.
 */
export function encodeAttestationData(data: AttestationData): string {
  return SCHEMA_ENCODER.encode(SCHEMA_TYPES, [
    data.verificationId,
    data.qualified,
    data.qualification,
    data.apiVersion,
    data.tier,
    data.mode,
    data.verdict,
    data.confidence,
    data.claimHash,
    data.evidenceHash,
    data.evaluatedAt,
  ]);
}

/**
 * Issue an on-chain attestation to Base Mainnet via EAS.
 *
 * Requires ATTESTER_PRIVATE_KEY environment variable.
 * Returns the attestation UID and transaction hash.
 *
 * This is an async side-effect — do NOT call from inside the engine.
 * The route layer decides when to attest (e.g., only for standard tier,
 * only when customer opts in, etc.).
 */
export async function issueAttestation(
  data: AttestationData,
  options?: {
    recipient?: string;  // default: zero address (public attestation)
    revocable?: boolean; // default: true
    rpcUrl?: string;     // override RPC for testing
    privateKey?: string; // override for testing (normally from env)
  },
): Promise<AttestationResult> {
  const privateKey = options?.privateKey ?? process.env.ATTESTER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('[sentinel-eas] ATTESTER_PRIVATE_KEY not set');
  }

  const rpcUrl = options?.rpcUrl ?? SENTINEL_EAS_CONFIG.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const eas = new ethers.Contract(
    SENTINEL_EAS_CONFIG.contracts.eas,
    EAS_ABI,
    wallet,
  );

  const encodedData = encodeAttestationData(data);

  const attestationRequest = {
    schema: SENTINEL_EAS_CONFIG.schemas.sentinelQualified.uid,
    data: {
      recipient: options?.recipient ?? ethers.ZeroAddress,
      expirationTime: BigInt(0),
      revocable: options?.revocable ?? true,
      refUID: ethers.ZeroHash,
      data: encodedData,
      value: BigInt(0),
    },
  };

  const tx = await eas.attest(attestationRequest);
  const receipt = await tx.wait();

  // Extract attestation UID from logs
  // EAS emits Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)
  const attestedEvent = receipt.logs.find(
    (log: ethers.Log) => log.topics.length >= 4,
  );

  const uid = attestedEvent?.topics?.[3]
    ?? '0x0000000000000000000000000000000000000000000000000000000000000000';

  return {
    uid,
    txHash: receipt.hash,
    attester: wallet.address,
    schemaUid: SENTINEL_EAS_CONFIG.schemas.sentinelQualified.uid,
  };
}
