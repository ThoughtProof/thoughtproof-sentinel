/**
 * Acceptance checks for the two follow-up defects on the action-binding draft.
 * Separate from the original 32-case offline harness.
 *
 * Keys are generated in this process. No network, model, or production call.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'crypto';
import canonicalize from 'canonicalize';
import { applyEvidenceEffects, processSignedEvidence } from './evidence-processing.js';
import { computePackageDigest } from './package-digest.js';
import { recomputeProposedActionDigest } from './action-binding.js';
import type {
  KeyManifest,
  SentinelVerifyRequest,
  SentinelVerifyResponse,
  SignedEventEvidence,
} from './types.js';

const RELEASE_140 =
  '{"artifact":"buzz-agent","artifact_sha256":"3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b","step":"deploy","target":"production","version":"1.4.0","workflow":"WF-release"}';
const RELEASE_141 =
  '{"artifact":"buzz-agent","artifact_sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","step":"deploy","target":"production","version":"1.4.1","workflow":"WF-release"}';
const DIGEST_140 = '9b6e839cfe71ffb839e834f82147d98b03a77eee69da436ef29e08cbb2d6d401';

/** Digest of this object before the own-key copy change. It must stay put. */
const LEGACY_PACKAGE_DIGEST =
  'sha256:5af16d09fca54a171ab217f8f2cb30544c2fc00960cef5091a26712ddd4fecec';

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
  return cryptoSign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(privateKeyPem)).toString('hex');
}

function buzzApproval() {
  return {
    approves_release_sha256: DIGEST_140,
    decision: 'ich signiere',
    step: 'deploy',
    type: 'approval',
    workflow: 'WF-release',
  };
}

function evidenceItem(
  payload: unknown,
  privateKeyPem: string,
  pubkeyHex: string,
  verification: 'required' | 'optional' = 'required',
): SignedEventEvidence {
  const raw = { payload, signature: signPayload(payload, privateKeyPem) };
  return {
    type: 'signed_event',
    raw_event: Buffer.from(JSON.stringify(raw), 'utf8').toString('base64'),
    signature_scheme: 'ed25519',
    signer_pubkey: pubkeyHex,
    claims: ['release_approval'],
    verification,
  };
}

function tamperSignature(item: SignedEventEvidence): SignedEventEvidence {
  const raw = JSON.parse(Buffer.from(item.raw_event, 'base64').toString('utf8')) as {
    payload: unknown;
    signature: string;
  };
  const last = raw.signature.length - 1;
  const flip = raw.signature[last] === 'a' ? 'b' : 'a';
  raw.signature = raw.signature.slice(0, last) + flip;
  return {
    ...item,
    raw_event: Buffer.from(JSON.stringify(raw), 'utf8').toString('base64'),
  };
}

function settle(request: SentinelVerifyRequest, upstream: 'ALLOW' | 'BLOCK' | 'UNCERTAIN' = 'ALLOW') {
  const processed = processSignedEvidence(request);
  const upstreamResponse: SentinelVerifyResponse = {
    id: 'offline-synthetic',
    verdict: upstream,
    confidence: 0.99,
    reasoning: 'SYNTHETIC upstream ALLOW; no engine was run',
    objections: [],
    mode: request.mode,
    tier: 'standard',
    meta: {
      duration_ms: 0,
      models_used: [],
      verified_at: '2026-11-11T00:00:00.000Z',
    },
  };
  return {
    processed,
    response: applyEvidenceEffects(upstreamResponse, processed, request),
  };
}

function approvalRequest(
  item: SignedEventEvidence,
  proposedAction: string | undefined,
  manifest?: KeyManifest,
): SentinelVerifyRequest {
  return {
    claim: 'Deploy exactly the proposed buzz-agent release',
    evidence: 'Mandate: release approval supplied as signed evidence.',
    mode: 'action_authorization',
    ...(proposedAction !== undefined ? { proposed_action: proposedAction } : {}),
    signed_evidence: [item],
    ...(manifest ? { key_manifest: manifest } : {}),
  };
}

describe('approval fail-closed acceptance', () => {
  const key = testKey();
  const approval = buzzApproval();

  it('accepts 1.4.0 when proposed_action matches the signed digest', () => {
    const item = evidenceItem(approval, key.privateKeyPem, key.pubkeyHex);
    const { processed, response } = settle(approvalRequest(item, RELEASE_140));
    expect(processed.evidenceVerification[0].status).toBe('recomputed');
    expect(processed.shouldForceVerdict).toBe(false);
    expect(response.verdict).toBe('ALLOW');
  });

  it('blocks 1.4.1 under the same approval', () => {
    const item = evidenceItem(approval, key.privateKeyPem, key.pubkeyHex);
    const { processed, response } = settle(approvalRequest(item, RELEASE_141));
    expect(processed.evidenceVerification[0].code).toBe('action_binding_mismatch');
    expect(response.verdict).toBe('BLOCK');
  });

  it('blocks a missing proposed_action', () => {
    const item = evidenceItem(approval, key.privateKeyPem, key.pubkeyHex);
    const { processed, response } = settle(approvalRequest(item, undefined));
    expect(processed.evidenceVerification[0].code).toBe('action_binding_missing_action');
    expect(response.verdict).toBe('BLOCK');
  });

  it('blocks an optional approval whose signature was corrupted', () => {
    const item = tamperSignature(
      evidenceItem(approval, key.privateKeyPem, key.pubkeyHex, 'optional'),
    );
    const { processed, response } = settle(approvalRequest(item, RELEASE_141));
    expect(processed.evidenceVerification[0].code).toBe('evidence_signature_invalid');
    expect(processed.evidenceVerification[0].status).toBe('failed');
    expect(processed.forcedVerdict).toBe('BLOCK');
    expect(response.verdict).toBe('BLOCK');
  });

  it('blocks an optional approval signed by a revoked key when the action matches', () => {
    const item = evidenceItem(approval, key.privateKeyPem, key.pubkeyHex, 'optional');
    const manifest: KeyManifest = {
      version: 'offline-test',
      keys: [{ pubkey: key.pubkeyHex, status: 'revoked', roles: ['release_approval'] }],
    };
    const { processed, response } = settle(approvalRequest(item, RELEASE_140, manifest));
    expect(processed.evidenceVerification[0].code).toBe('signer_not_authorized');
    expect(processed.forcedVerdict).toBe('BLOCK');
    expect(response.verdict).toBe('BLOCK');
  });

  it('blocks an optional approval when the manifest role does not match or the key is rotated', () => {
    const item = evidenceItem(approval, key.privateKeyPem, key.pubkeyHex, 'optional');
    const wrongRole: KeyManifest = {
      version: 'offline-test',
      keys: [{ pubkey: key.pubkeyHex, status: 'active', roles: ['owner_signoff'] }],
    };
    const rotated: KeyManifest = {
      version: 'offline-test',
      keys: [{ pubkey: key.pubkeyHex, status: 'rotated', roles: ['release_approval'] }],
    };
    expect(settle(approvalRequest(item, RELEASE_140, wrongRole)).response.verdict).toBe('BLOCK');
    expect(settle(approvalRequest(item, RELEASE_140, rotated)).response.verdict).toBe('BLOCK');
    expect(
      settle(approvalRequest(item, RELEASE_140, rotated)).processed.evidenceVerification[0].code,
    ).toBe('signer_not_authorized');
  });

  it('blocks an optional approval when the manifest cannot be checked', () => {
    const item = evidenceItem(approval, key.privateKeyPem, key.pubkeyHex, 'optional');
    const referenced: SignedEventEvidence = {
      ...item,
      key_manifest_ref: 'offline-manifest-not-supplied',
    };
    const missingKey: KeyManifest = { version: 'offline-test', keys: [] };
    expect(settle(approvalRequest(referenced, RELEASE_140)).response.verdict).toBe('BLOCK');
    expect(settle(approvalRequest(referenced, RELEASE_140)).processed.forcedVerdict).toBe('BLOCK');
    expect(settle(approvalRequest(item, RELEASE_140, missingKey)).response.verdict).toBe('BLOCK');
    expect(
      settle(approvalRequest(item, RELEASE_140, missingKey)).processed.evidenceVerification[0].code,
    ).toBe('key_manifest_unverifiable');
  });

  it('leaves an optional non-approval with a broken signature as ALLOW', () => {
    const payload = { action: 'transfer', amount: 100, to: 'alice' };
    const item = tamperSignature(
      evidenceItem(payload, key.privateKeyPem, key.pubkeyHex, 'optional'),
    );
    const { processed, response } = settle({
      claim: 'Transfer 100',
      evidence: 'No approval digest.',
      mode: 'handoff',
      signed_evidence: [item],
    });
    expect(processed.shouldForceVerdict).toBe(false);
    expect(processed.evidenceVerification[0].code).toBe('evidence_signature_invalid');
    expect(response.verdict).toBe('ALLOW');
  });
});

describe('package digest own keys', () => {
  const legacy: SentinelVerifyRequest = {
    claim: 'Agent decided to transfer funds',
    evidence: 'Policy requires approval for transfers > $1000. Transfer amount: $500.',
    mode: 'handoff',
    tier: 'standard',
  };

  it('keeps the verdict and package digest of a legacy request with no approval shape', () => {
    expect(computePackageDigest(legacy)).toBe(LEGACY_PACKAGE_DIGEST);
    const { processed, response } = settle(legacy);
    expect(processed.shouldForceVerdict).toBe(false);
    expect(response.verdict).toBe('ALLOW');
    expect(response.meta.package_digest).toBeUndefined();
    expect(computePackageDigest(legacy)).toBe(LEGACY_PACKAGE_DIGEST);
  });

  it('gives distinct package digests to proposed_action objects that differ only by an own __proto__ key', () => {
    const withProto = JSON.parse('{"version":"1.4.0","__proto__":{"extra":1}}') as Record<string, unknown>;
    const plain = JSON.parse('{"version":"1.4.0"}') as Record<string, unknown>;
    const withConstructor = JSON.parse('{"version":"1.4.0","constructor":{"x":1}}') as Record<string, unknown>;
    const withPrototype = JSON.parse('{"version":"1.4.0","prototype":{"y":2}}') as Record<string, unknown>;
    expect(Object.hasOwn(withProto, '__proto__')).toBe(true);

    const request = (action: unknown): SentinelVerifyRequest => ({
      claim: 'Deploy',
      evidence: 'bytes',
      mode: 'handoff',
      proposed_action: action,
    });
    const digestA = computePackageDigest(request(withProto));
    const digestB = computePackageDigest(request(plain));
    expect(digestA).not.toBe(digestB);
    expect(recomputeProposedActionDigest(withProto)).not.toBe(recomputeProposedActionDigest(plain));
    expect(computePackageDigest(request(withConstructor))).not.toBe(digestB);
    expect(computePackageDigest(request(withPrototype))).not.toBe(digestB);

    const dir = mkdtempSync(join(tmpdir(), 'pkg-digest-'));
    const requestAPath = join(dir, 'request-a.json');
    const requestBPath = join(dir, 'request-b.json');
    const receiptAPath = join(dir, 'receipt-a.json');
    writeFileSync(requestAPath, JSON.stringify(request(withProto)));
    writeFileSync(requestBPath, JSON.stringify(request(plain)));
    writeFileSync(
      receiptAPath,
      JSON.stringify({
        id: 'proto-a',
        verdict: 'ALLOW',
        confidence: 1,
        tier: 'standard',
        mode: 'handoff',
        meta: { package_digest: digestA },
      }),
    );

    const script = join(process.cwd(), 'scripts', 'verify-receipt.mjs');
    const againstA = spawnSync(process.execPath, [script, receiptAPath, requestAPath], { encoding: 'utf8' });
    const againstB = spawnSync(process.execPath, [script, receiptAPath, requestBPath], { encoding: 'utf8' });
    expect(againstA.status).toBe(0);
    expect(againstB.status).toBe(1);
  });
});
