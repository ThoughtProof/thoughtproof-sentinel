/**
 * Server path and scripts/verify-receipt.mjs on the same bytes.
 *
 * The binding decision comes from one module (src/action-binding-core.mjs).
 * No network, model, or production call. Upstream verdicts are synthetic.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import canonicalize from 'canonicalize';
import { checkActionBinding } from './action-binding.js';
import { checkActionBinding as sharedCheckActionBinding } from './action-binding-core.mjs';
import { applyEvidenceEffects, processSignedEvidence } from './evidence-processing.js';
import { computePackageDigest } from './package-digest.js';
import type {
  SentinelVerifyRequest,
  SentinelVerifyResponse,
  SignedEventEvidence,
} from './types.js';
import { validateVerifyRequest } from './validation.js';

const RELEASE_140 =
  '{"artifact":"buzz-agent","artifact_sha256":"3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b","step":"deploy","target":"production","version":"1.4.0","workflow":"WF-release"}';
const RELEASE_141 =
  '{"artifact":"buzz-agent","artifact_sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","step":"deploy","target":"production","version":"1.4.1","workflow":"WF-release"}';
const DIGEST_140 = createHash('sha256').update(RELEASE_140, 'utf8').digest('hex');

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

const key = testKey();

function signPayload(payload: unknown): string {
  const canonical = (canonicalize as unknown as (v: unknown) => string)(payload);
  return cryptoSign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(key.privateKeyPem)).toString('hex');
}

function evidenceItem(payload: unknown, verification: 'required' | 'optional' = 'optional'): SignedEventEvidence {
  const raw = { payload, signature: signPayload(payload) };
  return {
    type: 'signed_event',
    raw_event: Buffer.from(JSON.stringify(raw), 'utf8').toString('base64'),
    signature_scheme: 'ed25519',
    signer_pubkey: key.pubkeyHex,
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
  return { ...item, raw_event: Buffer.from(JSON.stringify(raw), 'utf8').toString('base64') };
}

function tamperPayload(item: SignedEventEvidence): SignedEventEvidence {
  const raw = JSON.parse(Buffer.from(item.raw_event, 'base64').toString('utf8')) as {
    payload: Record<string, unknown>;
    signature: string;
  };
  raw.payload = { ...raw.payload, decision: 'tampered' };
  return { ...item, raw_event: Buffer.from(JSON.stringify(raw), 'utf8').toString('base64') };
}

function buzzApproval(extra: Record<string, unknown> = {}) {
  return {
    approves_release_sha256: DIGEST_140,
    decision: 'ich signiere',
    step: 'deploy',
    type: 'approval',
    workflow: 'WF-release',
    ...extra,
  };
}

function accept(body: Record<string, unknown>): SentinelVerifyRequest {
  const validated = validateVerifyRequest(body);
  if (!validated.valid) {
    throw new Error(JSON.stringify(validated.errors));
  }
  return validated.data;
}

function requestFor(proposed: unknown | typeof ABSENT, item: SignedEventEvidence): SentinelVerifyRequest {
  return accept({
    claim: 'Deploy buzz-agent',
    evidence: 'Offline parity: the action bytes are proposed_action',
    mode: 'action_authorization',
    tier: 'standard',
    ...(proposed === ABSENT ? {} : { proposed_action: proposed }),
    signed_evidence: [item],
    key_manifest: {
      version: 'test',
      keys: [{ pubkey: key.pubkeyHex, status: 'active', roles: ['release_approval'] }],
    },
  });
}

const ABSENT = Symbol('absent');

function settle(request: SentinelVerifyRequest) {
  const processed = processSignedEvidence(request);
  const upstream: SentinelVerifyResponse = {
    id: 'offline-synthetic',
    verdict: 'ALLOW',
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
    response: applyEvidenceEffects(upstream, processed, request),
  };
}

interface PortableItem {
  index: number;
  status: string;
  code: string | null;
  signature: { status: string; code: string | null };
  binding: { status: string; code: string | null };
  authority: { status: string; code: string | null };
}

function runPortable(request: unknown, receipt: unknown, pubkey?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'portable-binding-'));
  const requestPath = join(dir, 'request.json');
  const receiptPath = join(dir, 'receipt.json');
  writeFileSync(requestPath, JSON.stringify(request));
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const args = [join(process.cwd(), 'scripts', 'verify-receipt.mjs'), receiptPath, requestPath];
  if (pubkey) args.push('--trusted-pubkey', pubkey);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const lines = (result.stdout || '')
    .split('\n')
    .filter((line) => line.startsWith('PORTABLE_ITEM '))
    .map((line) => JSON.parse(line.slice('PORTABLE_ITEM '.length)) as PortableItem);
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    items: lines,
  };
}

function trace(result: { status: number | null; stdout: string; stderr: string }): string {
  return `exit=${result.status}\n${result.stdout}\n${result.stderr}`;
}

describe('portable verifier shares the server binding predicate', () => {
  it('publishes the Buzz 1.4.0 digest the fixture uses', () => {
    expect(DIGEST_140).toBe('9b6e839cfe71ffb839e834f82147d98b03a77eee69da436ef29e08cbb2d6d401');
  });

  it('re-exports the same function the portable script imports', () => {
    expect(checkActionBinding).toBe(sharedCheckActionBinding);
    const source = readFileSync(join(process.cwd(), 'scripts', 'verify-receipt.mjs'), 'utf8');
    expect(source).toContain("from '../src/action-binding-core.mjs'");
    expect(source).not.toContain('function checkActionBinding');
  });

  it.each([
    {
      name: 'positive 1.4.0',
      proposed: RELEASE_140 as unknown,
      item: () => evidenceItem(buzzApproval()),
      verdict: 'ALLOW' as const,
      code: null,
      signature: 'passed',
      binding: 'passed',
      bindingCode: null,
    },
    {
      name: 'wrong release 1.4.1',
      proposed: RELEASE_141 as unknown,
      item: () => evidenceItem(buzzApproval()),
      verdict: 'BLOCK' as const,
      code: 'action_binding_mismatch',
      signature: 'passed',
      binding: 'failed',
      bindingCode: 'action_binding_mismatch',
    },
    {
      name: 'missing proposed_action',
      proposed: ABSENT as unknown,
      item: () => evidenceItem(buzzApproval()),
      verdict: 'BLOCK' as const,
      code: 'action_binding_missing_action',
      signature: 'passed',
      binding: 'failed',
      bindingCode: 'action_binding_missing_action',
    },
    {
      name: 'unknown binding_profile',
      proposed: RELEASE_140 as unknown,
      item: () => evidenceItem(buzzApproval({ binding_profile: 'not-a-profile' })),
      verdict: 'BLOCK' as const,
      code: 'action_binding_unsupported_profile',
      signature: 'passed',
      binding: 'failed',
      bindingCode: 'action_binding_unsupported_profile',
    },
    {
      name: 'tampered payload',
      proposed: RELEASE_140 as unknown,
      item: () => tamperPayload(evidenceItem(buzzApproval())),
      verdict: 'BLOCK' as const,
      code: 'evidence_signature_invalid',
      signature: 'failed',
      binding: 'not_checked',
      bindingCode: null,
    },
    {
      name: 'tampered signature',
      proposed: RELEASE_140 as unknown,
      item: () => tamperSignature(evidenceItem(buzzApproval())),
      verdict: 'BLOCK' as const,
      code: 'evidence_signature_invalid',
      signature: 'failed',
      binding: 'not_checked',
      bindingCode: null,
    },
    {
      name: 'legacy non-approval',
      proposed: RELEASE_140 as unknown,
      item: () => evidenceItem({ note: 'ordinary optional evidence' }),
      verdict: 'ALLOW' as const,
      code: null,
      signature: 'passed',
      binding: 'not_checked',
      bindingCode: null,
    },
  ])('$name has the same outcome on the server and in the portable verifier', (spec) => {
    const request = requestFor(spec.proposed === ABSENT ? ABSENT : spec.proposed, spec.item());
    const server = settle(request);
    const evidence = server.processed.evidenceVerification[0];
    expect(server.response.verdict).toBe(spec.verdict);
    expect(evidence?.code ?? null).toBe(spec.code);

    const portable = runPortable(request, server.response, key.pubkeyHex);
    expect(portable.status, trace(portable)).toBe(spec.verdict === 'ALLOW' ? 0 : 1);
    expect(portable.items).toHaveLength(1);
    const item = portable.items[0];
    expect(item.status).toBe(evidence?.status);
    expect(item.code).toBe(evidence?.code ?? null);
    expect(item.signature.status).toBe(spec.signature);
    expect(item.binding.status).toBe(spec.binding);
    expect(item.binding.code).toBe(spec.bindingCode);
    expect(item.authority.status).toBe('passed');
    expect(item.authority.code).toBeNull();
  });

  it('keeps the portable exit code for an optional legacy signature failure', () => {
    const request = requestFor(RELEASE_140, tamperSignature(evidenceItem({ note: 'ordinary optional evidence' })));
    const server = settle(request);
    expect(server.response.verdict).toBe('ALLOW');
    expect(server.processed.evidenceVerification[0].code).toBe('evidence_signature_invalid');
    expect(server.processed.shouldForceVerdict).toBe(false);

    const portable = runPortable(request, server.response, key.pubkeyHex);
    expect(portable.status, trace(portable)).toBe(1);
    expect(portable.items[0].signature.status).toBe('failed');
    expect(portable.items[0].binding.status).toBe('not_checked');
    expect(portable.items[0].code).toBe('evidence_signature_invalid');
  });

  it('keeps exit 0 for a legacy request with no approval shape and no signed evidence', () => {
    const legacy = accept({
      claim: 'Agent decided to transfer funds',
      evidence: 'Policy requires approval for transfers > $1000. Transfer amount: $500.',
      mode: 'handoff',
      tier: 'standard',
    });
    expect(computePackageDigest(legacy)).toBe(LEGACY_PACKAGE_DIGEST);
    const server = settle(legacy);
    expect(server.response.verdict).toBe('ALLOW');
    const receipt = {
      id: 'legacy',
      verdict: 'ALLOW',
      confidence: 1,
      tier: 'standard',
      mode: 'handoff',
      meta: { package_digest: LEGACY_PACKAGE_DIGEST },
    };
    const portable = runPortable(legacy, receipt);
    expect(portable.status, trace(portable)).toBe(0);
    expect(portable.items).toHaveLength(0);
  });
});
