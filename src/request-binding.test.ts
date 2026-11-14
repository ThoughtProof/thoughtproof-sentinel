/**
 * Shared request-binding v2 vectors from thoughtproof-mcp
 * (faf89b6492d198da7daac41cb13e5257ebf03823).
 * Synthetic offline fixtures. Not production receipts.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  REQUEST_BINDING_PROFILE,
  REQUEST_HASH_RE,
  RequestBindingRejected,
  canonicalBindsRequest,
  canonicalRequestBinding,
  computeRequestHash,
  jcs,
} from './request-binding.js';
import {
  buildCanonicalSentinelVerdict,
  buildCanonicalSentinelVerdictV2,
  serializeCanonicalSentinelVerdict,
} from './canonical-verdict.js';
import {
  generateExportKeyPair,
  issueSignedCanonicalExport,
  verifySignedCanonicalExport,
} from './canonical-export.js';
import type { SentinelVerifyResponse } from './types.js';

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/request-binding-v2.json',
);

interface Vector {
  id: string;
  reject?: boolean;
  body: Record<string, unknown>;
  envelope?: { profile: string; request: unknown };
  jcs?: string;
  requestHash?: string;
  serializedVariants?: string[];
  differsFrom?: string;
}

const doc = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  profile: string;
  vectors: Vector[];
};

function byId(id: string): Vector {
  const vector = doc.vectors.find((item) => item.id === id);
  expect(vector, id).toBeTruthy();
  return vector as Vector;
}

const response = (): SentinelVerifyResponse => ({
  id: 'sent_bind_unit',
  verdict: 'ALLOW',
  confidence: 0.5,
  reasoning: 'unit',
  objections: [],
  mode: 'action_authorization',
  tier: 'checkpoint',
  meta: {
    duration_ms: 1,
    models_used: ['serv-nano'],
    verified_at: '2026-11-14T00:00:00.000Z',
  },
});

describe('request-binding v2 vectors', () => {
  it('pins profile, JCS, and sha256 for every valid vector and rejects the three lone surrogates', () => {
    expect(doc.profile).toBe(REQUEST_BINDING_PROFILE);
    const valid = doc.vectors.filter((item) => !item.reject);
    const rejected = doc.vectors.filter((item) => item.reject);
    expect(valid).toHaveLength(8);
    expect(rejected).toHaveLength(3);

    for (const vector of valid) {
      expect(vector.envelope?.profile).toBe(REQUEST_BINDING_PROFILE);
      expect(vector.envelope?.request).toEqual(vector.body);
      expect(jcs(vector.envelope)).toBe(vector.jcs);
      expect(canonicalRequestBinding(vector.body)).toBe(vector.jcs);
      const digest = `sha256:${createHash('sha256').update(vector.jcs ?? '', 'utf8').digest('hex')}`;
      expect(digest).toBe(vector.requestHash);
      expect(computeRequestHash(vector.body)).toBe(vector.requestHash);
      expect(vector.requestHash).toMatch(REQUEST_HASH_RE);
    }

    for (const vector of rejected) {
      expect(() => jcs(vector.body)).toThrow(RequestBindingRejected);
      expect(() => computeRequestHash(vector.body)).toThrow(RequestBindingRejected);
      expect(() => canonicalRequestBinding(vector.body)).toThrow(RequestBindingRejected);
    }
  });

  it('treats key order and indentation as the same hash and inside-string whitespace as different', () => {
    const decision = byId('decision-builder');
    expect(decision.serializedVariants?.length).toBeGreaterThanOrEqual(2);
    for (const serialized of decision.serializedVariants ?? []) {
      expect(computeRequestHash(JSON.parse(serialized))).toBe(decision.requestHash);
    }
    expect(decision.serializedVariants?.[0]).not.toBe(decision.serializedVariants?.[1]);

    const spaced = byId('inside-string-whitespace');
    expect(spaced.requestHash).not.toBe(decision.requestHash);
    expect(spaced.body.claim).not.toBe(decision.body.claim);

    const extra = byId('unknown-extra-field');
    expect(extra.body['x-extra']).toBe('kept');
    expect(extra.requestHash).not.toBe(decision.requestHash);

    const nulled = byId('null-mandate');
    expect(nulled.body.mandate).toBeNull();
    expect(Object.hasOwn(decision.body, 'mandate')).toBe(false);
    expect(nulled.requestHash).not.toBe(decision.requestHash);

    for (const vector of doc.vectors) {
      if (!vector.differsFrom || !vector.requestHash) continue;
      expect(vector.requestHash).not.toBe(byId(vector.differsFrom).requestHash);
    }
  });

  it('does not trim, case-fold, or Unicode-normalize, and keeps an own __proto__ key', () => {
    const base = { claim: 'git status', evidence: 'e', mode: 'action_authorization', tier: 'checkpoint' };
    expect(computeRequestHash({ ...base, claim: ' git status' })).not.toBe(computeRequestHash(base));
    expect(computeRequestHash({ ...base, claim: 'GIT STATUS' })).not.toBe(computeRequestHash(base));
    const composed = computeRequestHash({ ...base, claim: '\u00e9' });
    const decomposed = computeRequestHash({ ...base, claim: 'e\u0301' });
    expect(composed).not.toBe(decomposed);

    const plain = JSON.parse('{"claim":"a","evidence":"b"}') as Record<string, unknown>;
    const withProto = JSON.parse('{"__proto__":{"admin":true},"claim":"a","evidence":"b"}') as Record<
      string,
      unknown
    >;
    expect(computeRequestHash(withProto)).not.toBe(computeRequestHash(plain));
    expect(canonicalRequestBinding(withProto)).toContain('"__proto__"');
  });

  it('hashes a client requestHash field as body content and does not adopt it', () => {
    const client = `sha256:${'ab'.repeat(32)}`;
    const body = {
      claim: 'run',
      evidence: 'because',
      mode: 'action_authorization',
      tier: 'checkpoint',
      requestHash: client,
    };
    const bound = computeRequestHash(body);
    expect(bound).not.toBe(client);
    expect(bound).not.toBe(computeRequestHash({ ...body, requestHash: undefined }));
    const without = { ...body };
    delete (without as { requestHash?: string }).requestHash;
    expect(bound).not.toBe(computeRequestHash(without));
  });

  it('puts the same requestHash on v1 and v2 canonicals and leaves the historical body unchanged without it', () => {
    const hash = computeRequestHash(byId('decision-builder').body);
    const v1 = buildCanonicalSentinelVerdict(response(), { requestHash: hash });
    const v2 = buildCanonicalSentinelVerdictV2(response(), { requestHash: hash, potCli: '0.8.13' });
    expect(v1.requestHash).toBe(hash);
    expect(v2.requestHash).toBe(hash);
    expect(v1.artifactSchema).toBe('sentinel.verdict.canonical.v1');
    expect(v2.artifactSchema).toBe('sentinel.verdict.canonical.v2');
    const v1Json = serializeCanonicalSentinelVerdict(v1);
    const v2Json = serializeCanonicalSentinelVerdict(v2);
    expect(JSON.parse(v1Json).requestHash).toBe(hash);
    expect(JSON.parse(v2Json).requestHash).toBe(hash);
    expect(canonicalBindsRequest(v1Json, hash)).toBe(true);
    expect(canonicalBindsRequest(v2Json, hash)).toBe(true);
    expect(canonicalBindsRequest(v2Json, `sha256:${'cd'.repeat(32)}`)).toBe(false);

    const historical = serializeCanonicalSentinelVerdict(buildCanonicalSentinelVerdict(response()));
    expect(historical).not.toContain('requestHash');
    expect(JSON.parse(historical)).not.toHaveProperty('requestHash');

    expect(() => buildCanonicalSentinelVerdict(response(), { requestHash: 'sha256:ABCD' })).toThrow(
      /requestHash/,
    );
  });

  it('signs requestHash into both export formats and the existing verifier covers that field', () => {
    const hash = computeRequestHash(byId('trade-builder').body);
    const { privateKey, publicKey } = generateExportKeyPair();
    const now = 1_700_000_000;
    const v1 = issueSignedCanonicalExport(response(), {
      privateKey,
      keyId: 'test-binding',
      nowSeconds: now,
      ttlSeconds: 60,
      requestHash: hash,
    });
    const v2 = issueSignedCanonicalExport(
      buildCanonicalSentinelVerdictV2(response(), { requestHash: hash, potCli: '0.8.13' }),
      { privateKey, keyId: 'test-binding', nowSeconds: now, ttlSeconds: 60 },
    );
    expect(verifySignedCanonicalExport(v1, publicKey, { nowSeconds: now }).ok).toBe(true);
    expect(verifySignedCanonicalExport(v2, publicKey, { nowSeconds: now }).ok).toBe(true);
    expect(JSON.parse(v1.canonical).requestHash).toBe(hash);
    expect(JSON.parse(v2.canonical).requestHash).toBe(hash);
    expect(v1.artifactSchema).toBe('sentinel.verdict.canonical.v1');
    expect(v2.artifactSchema).toBe('sentinel.verdict.canonical.v2');

    const tampered = {
      ...v1,
      canonical: v1.canonical.replace(hash, `sha256:${'11'.repeat(32)}`),
    };
    expect(verifySignedCanonicalExport(tampered, publicKey, { nowSeconds: now }).ok).toBe(false);
  });
});
