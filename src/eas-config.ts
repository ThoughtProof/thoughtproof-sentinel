/**
 * Sentinel EAS Configuration — Base Mainnet
 *
 * Separate schema from PLV (verify.thoughtproof.ai). Same attester wallet,
 * different schema UID and field set.
 *
 * PLV uses: artifactURI + artifactHash (off-chain artifact reference)
 * Sentinel uses: claimHash + evidenceHash (on-chain input fingerprint)
 */

export const SENTINEL_EAS_CONFIG = {
  chainId: 8453,
  rpcUrl: 'https://mainnet.base.org',
  contracts: {
    schemaRegistry: '0x4200000000000000000000000000000000000020',
    eas: '0x4200000000000000000000000000000000000021',
  },
  schemas: {
    sentinelQualified: {
      schema: 'string verificationId,bool qualified,string qualification,string apiVersion,string tier,string mode,string verdict,uint8 confidence,bytes32 claimHash,bytes32 evidenceHash,uint64 evaluatedAt',
      uid: '0x3945d7be65761ff1a83a4d6e16a7d3adbe6ced982a7e139854b5bfe4c0748d2b',
    },
  },
  issuer: {
    /** Same production wallet as PLV — shared ThoughtProof attester identity. */
    productionWallet: '0x9C7C6F932A87Ee6Ac1B7183DEB58E00443CE999a',
  },
} as const;
