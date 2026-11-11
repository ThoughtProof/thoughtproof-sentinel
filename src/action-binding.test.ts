/**
 * Action-binding regression.
 *
 * Models the Buzz release pair (block/buzz#4179): one authentic approval of
 * buzz-agent 1.4.0, then the same approval attached to 1.4.0 and to 1.4.1.
 * Keys are generated in-process. No production key, no BIP-340 signature,
 * and no network or model call.
 *
 * Digests are sha256 of the published ASCII release canonical strings.
 */

import { describe, expect, it } from 'vitest';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'crypto';
import canonicalize from 'canonicalize';
import { ACTION_BINDING_PROFILE_V1, checkActionBinding } from './action-binding.js';
import { applyEvidenceEffects, processSignedEvidence } from './evidence-processing.js';
import { computePackageDigest } from './package-digest.js';
import type { SentinelVerifyRequest, SentinelVerifyResponse, SignedEventEvidence } from './types.js';
import { validateVerifyRequest } from './validation.js';

const RELEASE_140 =
  '{"artifact":"buzz-agent","artifact_sha256":"3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b","step":"deploy","target":"production","version":"1.4.0","workflow":"WF-release"}';
const RELEASE_141 =
  '{"artifact":"buzz-agent","artifact_sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","step":"deploy","target":"production","version":"1.4.1","workflow":"WF-release"}';
const DIGEST_140 = '9b6e839cfe71ffb839e834f82147d98b03a77eee69da436ef29e08cbb2d6d401';
const DIGEST_141 = '86de75b3bc3c577fff921fb7f553bc628d3193a1760c2b5b7342dce5be212202';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function testKey() {
  const generated = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const der = createPublicKey(generated.publicKey).export({ type: 'spki', format: 'der' });
  return {
    privateKeyPem: generated.privateKey,
    pubkeyHex: Buffer.from(der).subarray(12).toString('hex'),
  };
}

function signPayload(payload: unknown, privateKeyPem: string): string {
  const canonical = (canonicalize as unknown as (v: unknown) => string)(payload);
  const signature = cryptoSign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(privateKeyPem));
  return signature.toString('hex');
}

function evidenceItem(
  payload: unknown,
  privateKeyPem: string,
  pubkeyHex: string,
  claims: string[] = ['release_approval'],
  verification: 'required' | 'optional' = 'required',
): SignedEventEvidence {
  const raw = { payload, signature: signPayload(payload, privateKeyPem) };
  return {
    type: 'signed_event',
    raw_event: Buffer.from(JSON.stringify(raw), 'utf8').toString('base64'),
    signature_scheme: 'ed25519',
    signer_pubkey: pubkeyHex,
    claims,
    verification,
  };
}

/** Buzz approval content. The digest names 1.4.0 and nothing else. */
function buzzApproval() {
  return {
    approves_release_sha256: DIGEST_140,
    decision: 'ich signiere',
    step: 'deploy',
    type: 'approval',
    workflow: 'WF-release',
  };
}

function settle(request: SentinelVerifyRequest, upstream: 'ALLOW' | 'BLOCK' | 'UNCERTAIN' = 'ALLOW') {
  const processed = processSignedEvidence(request);
  const upstreamResponse: SentinelVerifyResponse = {
    id: 'offline-synthetic',
    verdict: upstream,
    confidence: 0.99,
    reasoning: 'SYNTHETIC upstream verdict; no engine was run',
    objections: [],
    mode: request.mode,
    tier: 'standard',
    meta: {
      duration_ms: 0,
      models_used: [],
      verified_at: '2026-11-11T00:00:00.000Z',
    },
  };
  const response = applyEvidenceEffects(upstreamResponse, processed, request);
  return { processed, response };
}

describe('action binding', () => {
  it('pins the Buzz release digests to the canonical release strings', () => {
    expect(sha256(RELEASE_140)).toBe(DIGEST_140);
    expect(sha256(RELEASE_141)).toBe(DIGEST_141);
    const asJcs = (canonicalize as unknown as (v: unknown) => string)(JSON.parse(RELEASE_140));
    expect(asJcs).toBe(RELEASE_140);
  });

  it('accepts the approved release and blocks the other release under the same signature', () => {
    const key = testKey();
    const item = evidenceItem(buzzApproval(), key.privateKeyPem, key.pubkeyHex);
    const base = {
      claim: 'Deploy exactly the proposed buzz-agent release',
      evidence: 'Mandate: release approval supplied as signed evidence.',
      mode: 'action_authorization' as const,
      signed_evidence: [item],
    };

    const approved = validateVerifyRequest({
      ...base,
      proposed_action: RELEASE_140,
      // Caller-supplied hash of the OTHER release must not satisfy the check.
      action_hash: `0x${DIGEST_141}`,
    });
    const mismatched = validateVerifyRequest({
      ...base,
      proposed_action: RELEASE_141,
      // Caller-supplied hash of the APPROVED release must not satisfy the check.
      action_hash: `0x${DIGEST_140}`,
    });
    expect(approved.valid).toBe(true);
    expect(mismatched.valid).toBe(true);
    if (!approved.valid || !mismatched.valid) return;

    expect(computePackageDigest(approved.data)).not.toBe(computePackageDigest(mismatched.data));

    const happy = settle(approved.data, 'ALLOW');
    expect(happy.processed.evidenceVerification[0].status).toBe('recomputed');
    expect(happy.processed.evidenceVerification[0].claims_validated).toBeUndefined();
    expect(happy.processed.shouldForceVerdict).toBe(false);
    expect(happy.processed.proofStrength).toBe('recomputed');
    expect(happy.response.verdict).toBe('ALLOW');

    const wrong = settle(mismatched.data, 'ALLOW');
    expect(wrong.processed.evidenceVerification[0].status).toBe('failed');
    expect(wrong.processed.evidenceVerification[0].severity).toBe('block');
    expect(wrong.processed.evidenceVerification[0].code).toBe('action_binding_mismatch');
    expect(wrong.processed.additionalObjections[0].reasoning).toContain(
      'action_binding_mismatch:0 — Evidence verification failed',
    );
    expect(wrong.processed.shouldForceVerdict).toBe(true);
    expect(wrong.processed.forcedVerdict).toBe('BLOCK');
    expect(wrong.processed.proofStrength).toBe('unverified');
    expect(wrong.response.verdict).toBe('BLOCK');
    expect(wrong.response.verdict).not.toBe('ALLOW');
  });

  it('still blocks a mismatched approval when the item is marked optional', () => {
    const key = testKey();
    const item = evidenceItem(buzzApproval(), key.privateKeyPem, key.pubkeyHex, ['release_approval'], 'optional');
    const { response, processed } = settle({
      claim: 'Deploy buzz-agent 1.4.1',
      evidence: 'Same approval as 1.4.0.',
      mode: 'action_authorization',
      proposed_action: RELEASE_141,
      signed_evidence: [item],
    });
    expect(processed.evidenceVerification[0].code).toBe('action_binding_mismatch');
    expect(processed.forcedVerdict).toBe('BLOCK');
    expect(response.verdict).toBe('BLOCK');
  });

  it('turns an upstream UNCERTAIN into BLOCK on mismatch and does not upgrade BLOCK', () => {
    const key = testKey();
    const item = evidenceItem(buzzApproval(), key.privateKeyPem, key.pubkeyHex);
    const request: SentinelVerifyRequest = {
      claim: 'Deploy buzz-agent 1.4.1',
      evidence: 'Same approval as 1.4.0.',
      mode: 'action_authorization',
      proposed_action: RELEASE_141,
      signed_evidence: [item],
    };
    expect(settle(request, 'UNCERTAIN').response.verdict).toBe('BLOCK');
    expect(settle(request, 'BLOCK').response.verdict).toBe('BLOCK');
  });

  it('fails closed when the profile omits the signed digest', () => {
    const key = testKey();
    const item = evidenceItem(
      { binding_profile: ACTION_BINDING_PROFILE_V1, type: 'approval' },
      key.privateKeyPem,
      key.pubkeyHex,
    );
    const { processed, response } = settle({
      claim: 'Deploy buzz-agent',
      evidence: 'Profile without a digest.',
      mode: 'action_authorization',
      proposed_action: RELEASE_140,
      signed_evidence: [item],
    });
    expect(processed.evidenceVerification[0].code).toBe('action_binding_missing_digest');
    expect(response.verdict).toBe('BLOCK');
  });

  it('fails closed when the request has no proposed_action to recompute', () => {
    const key = testKey();
    const item = evidenceItem(buzzApproval(), key.privateKeyPem, key.pubkeyHex);
    const { processed, response } = settle({
      claim: 'Deploy buzz-agent 1.4.0',
      evidence: 'Approval present, preimage absent.',
      mode: 'action_authorization',
      action_hash: `0x${DIGEST_140}`,
      signed_evidence: [item],
    });
    expect(processed.evidenceVerification[0].code).toBe('action_binding_missing_action');
    expect(response.verdict).toBe('BLOCK');
  });

  it('fails closed when the digest is only in outer claims', () => {
    const key = testKey();
    const item = evidenceItem(
      { action: 'transfer', amount: 1 },
      key.privateKeyPem,
      key.pubkeyHex,
      [`approves_release_sha256:${DIGEST_140}`],
    );
    const { processed, response } = settle({
      claim: 'Deploy buzz-agent 1.4.0',
      evidence: 'Digest claimed outside the signature.',
      mode: 'action_authorization',
      proposed_action: RELEASE_140,
      signed_evidence: [item],
    });
    expect(processed.evidenceVerification[0].code).toBe('action_binding_digest_not_signed');
    expect(processed.evidenceVerification[0].claims_validated).toBeUndefined();
    expect(response.verdict).toBe('BLOCK');
  });

  it('rejects a tampered payload even when the new digest matches the proposed action', () => {
    const key = testKey();
    const signed = evidenceItem(buzzApproval(), key.privateKeyPem, key.pubkeyHex);
    const raw = JSON.parse(Buffer.from(signed.raw_event, 'base64').toString('utf8')) as {
      payload: { approves_release_sha256: string };
      signature: string;
    };
    raw.payload.approves_release_sha256 = DIGEST_141;
    const tampered: SignedEventEvidence = {
      ...signed,
      raw_event: Buffer.from(JSON.stringify(raw), 'utf8').toString('base64'),
    };
    const { processed, response } = settle({
      claim: 'Deploy buzz-agent 1.4.1',
      evidence: 'Payload digest swapped after signing.',
      mode: 'action_authorization',
      proposed_action: RELEASE_141,
      signed_evidence: [tampered],
    });
    expect(processed.evidenceVerification[0].code).toBe('evidence_signature_invalid');
    expect(response.verdict).toBe('BLOCK');
  });

  it('rejects a signature from a different local test key', () => {
    const signer = testKey();
    const other = testKey();
    const item = evidenceItem(buzzApproval(), signer.privateKeyPem, other.pubkeyHex);
    const { processed, response } = settle({
      claim: 'Deploy buzz-agent 1.4.0',
      evidence: 'Signed by a different key than signer_pubkey.',
      mode: 'action_authorization',
      proposed_action: RELEASE_140,
      signed_evidence: [item],
    });
    expect(processed.evidenceVerification[0].code).toBe('evidence_signature_invalid');
    expect(response.verdict).toBe('BLOCK');
  });

  it('passes profile v1 when the JCS digest of the proposed object matches', () => {
    const key = testKey();
    const proposed = JSON.parse(RELEASE_140) as Record<string, unknown>;
    const item = evidenceItem(
      { binding_profile: ACTION_BINDING_PROFILE_V1, approves_sha256: DIGEST_140 },
      key.privateKeyPem,
      key.pubkeyHex,
      ['release_approval'],
    );
    const validated = validateVerifyRequest({
      claim: 'Deploy buzz-agent 1.4.0',
      evidence: 'Profile v1 approval.',
      mode: 'action_authorization',
      proposed_action: proposed,
      signed_evidence: [item],
    });
    expect(validated.valid).toBe(true);
    if (!validated.valid) return;
    const { processed, response } = settle(validated.data);
    expect(processed.evidenceVerification[0].status).toBe('recomputed');
    expect(response.verdict).toBe('ALLOW');
  });

  it('fails closed on an unknown binding profile even if the digest would match', () => {
    const key = testKey();
    const item = evidenceItem(
      { binding_profile: 'buzz.nip01.v0', approves_sha256: DIGEST_140 },
      key.privateKeyPem,
      key.pubkeyHex,
    );
    const { processed, response } = settle({
      claim: 'Deploy buzz-agent 1.4.0',
      evidence: 'Unknown profile.',
      mode: 'action_authorization',
      proposed_action: RELEASE_140,
      signed_evidence: [item],
    });
    expect(processed.evidenceVerification[0].code).toBe('action_binding_unsupported_profile');
    expect(response.verdict).toBe('BLOCK');
  });

  it('fails closed on a prefixed or non-lowercase digest', () => {
    const key = testKey();
    const item = evidenceItem(
      { approves_release_sha256: `sha256:${DIGEST_140}` },
      key.privateKeyPem,
      key.pubkeyHex,
    );
    const { processed, response } = settle({
      claim: 'Deploy buzz-agent 1.4.0',
      evidence: 'Prefixed digest.',
      mode: 'action_authorization',
      proposed_action: RELEASE_140,
      signed_evidence: [item],
    });
    expect(processed.evidenceVerification[0].code).toBe('action_binding_malformed');
    expect(response.verdict).toBe('BLOCK');
  });

  it('still rejects a revoked manifest key after the digest matches', () => {
    const key = testKey();
    const item = evidenceItem(buzzApproval(), key.privateKeyPem, key.pubkeyHex);
    const { processed, response } = settle({
      claim: 'Deploy buzz-agent 1.4.0',
      evidence: 'Digest matches, signer key is revoked.',
      mode: 'action_authorization',
      proposed_action: RELEASE_140,
      signed_evidence: [item],
      key_manifest: {
        version: 'offline-test',
        keys: [{ pubkey: key.pubkeyHex, status: 'revoked', roles: ['release_approval'] }],
      },
    });
    expect(processed.evidenceVerification[0].code).toBe('signer_not_authorized');
    expect(response.verdict).toBe('BLOCK');
  });

  it('does not let a manifest uncertainty hide a binding mismatch', () => {
    const key = testKey();
    const item = evidenceItem(buzzApproval(), key.privateKeyPem, key.pubkeyHex);
    const { processed, response } = settle({
      claim: 'Deploy buzz-agent 1.4.1',
      evidence: 'Mismatch plus a manifest that does not contain the key.',
      mode: 'action_authorization',
      proposed_action: RELEASE_141,
      signed_evidence: [item],
      key_manifest: { version: 'offline-test', keys: [] },
    });
    expect(processed.evidenceVerification[0].code).toBe('action_binding_mismatch');
    expect(response.verdict).toBe('BLOCK');
  });

  it('leaves a signature-only item unchanged when it makes no approval claim', () => {
    const key = testKey();
    const payload = { action: 'transfer', amount: 100, to: 'alice', claims: ['owner_signoff'] };
    const item = evidenceItem(payload, key.privateKeyPem, key.pubkeyHex, ['different_unsigned_claim']);
    const { processed, response } = settle({
      claim: 'Transfer 100',
      evidence: 'No approval digest.',
      mode: 'handoff',
      proposed_action: RELEASE_141,
      signed_evidence: [item],
    });
    expect(processed.shouldForceVerdict).toBe(false);
    expect(processed.evidenceVerification[0].status).toBe('recomputed');
    expect(processed.evidenceVerification[0].claims_validated).toEqual(['owner_signoff']);
    expect(response.verdict).toBe('ALLOW');
  });

  it('rejects disagreeing signed digests before comparing the action', () => {
    const result = checkActionBinding(
      { approves_release_sha256: DIGEST_140, approves_sha256: DIGEST_141 },
      [],
      { present: true, value: RELEASE_140 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('action_binding_malformed');
  });
});
