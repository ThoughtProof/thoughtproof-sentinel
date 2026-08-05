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
 *
 * NOTE: ethers is lazy-loaded to keep Vercel function bundle small at cold start.
 */

import { createHash } from 'crypto';
import { SENTINEL_EAS_CONFIG } from '../eas-config.js';
import type { AttestationData, AttestationResult, SentinelVerifyResponse, SentinelVerifyRequest } from '../types.js';

// Lazy ethers — only loaded when actually attesting
let _ethers: typeof import('ethers') | null = null;
async function getEthers() {
  if (_ethers) return _ethers;
  _ethers = await import('ethers');
  return _ethers;
}

// EAS contract ABI — only the attest function we need
const EAS_ABI = [
  'function attest((bytes32 schema, (address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint256 value) data)) external payable returns (bytes32)',
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
];

// keccak256("Attested(address,address,bytes32,bytes32)") — this is an EAS event topic
// (EVM ABI encoding uses keccak), verified on-chain on Base. This value is
// unrelated to hashToBytes32 below.
export const ATTESTED_EVENT_TOPIC = '0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35';

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
 * Hash a string to bytes32 using **SHA-256** (Node.js crypto — no ethers needed).
 *
 * NOTE: despite the function name (`hashToBytes32`), this computes **SHA-256**,
 * NOT keccak256. The name is a historical artifact from when the on-chain
 * schema was designed with EVM ABI in mind. All existing EAS attestations
 * (schema 0x3945d7be… on Base) carry SHA-256 values in `claimHash`/`evidenceHash`.
 *
 * Used for claimHash and evidenceHash — on-chain fingerprint of inputs.
 * If you need keccak256 (EVM-native), do NOT call this function.
 */
export function hashToBytes32(input: string): string {
  const hash = createHash('sha256').update(input).digest('hex');
  return '0x' + hash;
}

/**
 * Build AttestationData from a verification request + response pair.
 * Pure function — no I/O, no ethers dependency.
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
    confidence: Math.max(0, Math.min(100, Math.round(res.confidence * 100))), // uint8 0-100, clamped
    claimHash: hashToBytes32(req.claim),
    evidenceHash: hashToBytes32(req.evidence),
    evaluatedAt: Math.floor(new Date(res.meta.verified_at).getTime() / 1000),
  };
}

/**
 * Encode attestation data into ABI-encoded bytes for the EAS schema.
 * Requires ethers (lazy-loaded).
 */
export async function encodeAttestationData(data: AttestationData): Promise<string> {
  const ethers = await getEthers();
  const encoder = new ethers.AbiCoder();
  return encoder.encode(SCHEMA_TYPES, [
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
  const ethers = await getEthers();

  // SECURITY: Handles production wallet private key. Only call when attestation is explicitly requested.
  const privateKey = options?.privateKey ?? process.env.ATTESTER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('[sentinel-eas] ATTESTER_PRIVATE_KEY not configured — required for on-chain attestation');
  }
  if (!/^(0x)?[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error('[sentinel-eas] Invalid private key format');
  }

  const rpcUrl = options?.rpcUrl ?? SENTINEL_EAS_CONFIG.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const eas = new ethers.Contract(
    SENTINEL_EAS_CONFIG.contracts.eas,
    EAS_ABI,
    wallet,
  );

  const encodedData = await encodeAttestationData(data);

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

  // Gas price protection — reject if network congestion makes attestation uneconomical
  const feeData = await provider.getFeeData();
  const maxGasPrice = ethers.parseUnits('5', 'gwei'); // Base L2 typical: 0.005-0.05 gwei, spike threshold: 5 gwei
  if (feeData.gasPrice && feeData.gasPrice > maxGasPrice) {
    throw new Error(
      `[sentinel-eas] Gas price too high: ${ethers.formatUnits(feeData.gasPrice, 'gwei')} gwei (max: 5 gwei). Deferring attestation.`
    );
  }

  const tx = await eas.attest(attestationRequest);
  const receipt = await tx.wait();

  // Extract attestation UID from EAS Attested event
  const easAddress = SENTINEL_EAS_CONFIG.contracts.eas.toLowerCase();
  const attestedEvent = receipt.logs.find(
    (log: { address: string; topics: string[] }) =>
      log.address.toLowerCase() === easAddress &&
      log.topics[0] === ATTESTED_EVENT_TOPIC &&
      log.topics.length >= 4,
  );

  if (!attestedEvent) {
    throw new Error(`[sentinel-eas] Attested event not found in tx ${receipt.hash}. Check EAS contract address and event signature.`);
  }

  // Decode the Attested event to extract the UID
  const iface = new ethers.Interface(EAS_ABI);
  const parsed = iface.parseLog({ topics: attestedEvent.topics as string[], data: attestedEvent.data });
  const uid = parsed?.args?.[2] as string; // uid is the 3rd parameter (non-indexed)

  if (!uid || uid === ethers.ZeroHash) {
    throw new Error(`[sentinel-eas] Invalid attestation UID in tx ${receipt.hash}`);
  }

  return {
    uid,
    txHash: receipt.hash,
    attester: wallet.address,
    schemaUid: SENTINEL_EAS_CONFIG.schemas.sentinelQualified.uid,
  };
}
