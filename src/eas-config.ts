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
    /**
     * Dedicated Sentinel attester wallet — intentionally SEPARATE from the PLV
     * issuer (0x9C7C…) so an anchoring-key compromise cannot touch PLV's issuer
     * identity, and the two can be rotated independently. Doc-only field: the
     * actual signer is derived from ATTESTER_PRIVATE_KEY at runtime.
     * NOTE: this key has passed through a chat session — rotate to a freshly
     * generated wallet before Sentinel attestations carry real reliance value.
     */
    productionWallet: '0x4216034851c14B77aebB63E84dEAA4A7E3E2710d',
  },
} as const;
