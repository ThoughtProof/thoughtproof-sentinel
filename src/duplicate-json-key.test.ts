/**
 * Duplicate keys in signed raw_event JSON.
 *
 * One parser (src/json-duplicate-keys.mjs) feeds the server and the portable
 * verifier. No network, model, or production call.
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
import { applyEvidenceEffects, processSignedEvidence } from './evidence-processing.js';
import { parseJsonText } from './json-duplicate-keys.mjs';
import type { SentinelVerifyRequest, SentinelVerifyResponse, SignedEventEvidence } from './types.js';
import { validateVerifyRequest } from './validation.js';

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

function accept(body: Record<string, unknown>): SentinelVerifyRequest {
  const validated = validateVerifyRequest(body);
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  return validated.data;
}

function requestFor(item: SignedEventEvidence): SentinelVerifyRequest {
  return accept({
    claim: 'Deploy buzz-agent',
    evidence: 'Duplicate-key parity. No engine was run.',
    mode: 'action_authorization',
    tier: 'standard',
    proposed_action: 'release-bytes',
    signed_evidence: [item],
    key_manifest: {
      version: 'test',
      keys: [{ pubkey: key.pubkeyHex, status: 'active', roles: ['release_approval'] }],
    },
  });
}

function itemFromRawJson(
  jsonText: string,
  verification: 'optional' | 'required' = 'optional',
  claims: string[] = ['release_approval'],
): SignedEventEvidence {
  return {
    type: 'signed_event',
    raw_event: Buffer.from(jsonText, 'utf8').toString('base64'),
    signature_scheme: 'ed25519',
    signer_pubkey: key.pubkeyHex,
    claims,
    verification,
  };
}

function signedUnique(payload: unknown, verification: 'optional' | 'required' = 'optional'): SignedEventEvidence {
  return itemFromRawJson(signedEnvelope(payload), verification);
}

function signPayload(payload: unknown): string {
  const canonical = (canonicalize as unknown as (v: unknown) => string)(payload);
  return cryptoSign(
    null,
    Buffer.from(canonical, 'utf8'),
    createPrivateKey(key.privateKeyPem),
  ).toString('hex');
}

function signedEnvelope(payload: unknown): string {
  return JSON.stringify({ payload, signature: signPayload(payload) });
}

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
  return { processed, response: applyEvidenceEffects(upstream, processed, request) };
}

interface PortableItem {
  status: string;
  code: string | null;
  signature: { status: string };
  binding: { status: string };
  authority: { status: string };
}

function runPortable(request: unknown, receipt: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'dup-json-'));
  const requestPath = join(dir, 'request.json');
  const receiptPath = join(dir, 'receipt.json');
  writeFileSync(requestPath, JSON.stringify(request));
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const result = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'verify-receipt.mjs'),
      receiptPath,
      requestPath,
      '--trusted-pubkey',
      key.pubkeyHex,
    ],
    { encoding: 'utf8' },
  );
  const items = (result.stdout || '')
    .split('\n')
    .filter((line) => line.startsWith('PORTABLE_ITEM '))
    .map((line) => JSON.parse(line.slice('PORTABLE_ITEM '.length)) as PortableItem);
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', items };
}

function trace(result: { status: number | null; stdout: string; stderr: string }): string {
  return `exit=${result.status}\n${result.stdout}\n${result.stderr}`;
}

describe('duplicate JSON keys', () => {
  it('agrees with JSON.parse on unique documents, including a single __proto__ key', () => {
    const values: unknown[] = [
      null,
      true,
      false,
      0,
      -2,
      0.5,
      1e-7,
      '',
      'a/b',
      [],
      { a: 1, b: [true, null, 'x'] },
      { '': 1 },
      { nested: { z: [1, { q: 'ok' }] } },
      JSON.parse('{"__proto__":{"version":"1.4.0"},"note":"once"}'),
      { note: '{"a":1,"a":2}' },
    ];
    for (const value of values) {
      const text = JSON.stringify(value);
      const parsed = parseJsonText(text);
      expect(parsed.ok, text).toBe(true);
      if (parsed.ok) {
        expect(JSON.stringify(parsed.value)).toBe(JSON.stringify(JSON.parse(text)));
      }
    }
    const escaped = parseJsonText(' { "k" : "\\u0061" } ');
    expect(escaped.ok).toBe(true);
    if (escaped.ok) expect(escaped.value).toEqual({ k: 'a' });
    const big = parseJsonText('1e309');
    expect(big.ok).toBe(true);
    if (big.ok) expect(big.value).toBe(JSON.parse('1e309'));
  });

  it('rejects invalid JSON instead of calling it a duplicate key', () => {
    for (const text of ['', '{', '[1,]', '{"a":01}', '{"a":1,}', 'truex', '"hi']) {
      const parsed = parseJsonText(text);
      expect(parsed.ok, text).toBe(false);
      if (!parsed.ok) expect(parsed.code, text).toBe('json_invalid');
    }
  });

  it('flags duplicates after unescaping, including __proto__, and keeps the last-key value', () => {
    const top = parseJsonText('{"a":1,"a":2}');
    expect(top.ok).toBe(false);
    if (!top.ok && top.code === 'duplicate_json_key') expect(top.value).toEqual({ a: 2 });

    const nested = parseJsonText('{"a":{"b":1,"b":2}}');
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.code).toBe('duplicate_json_key');

    const envelope = parseJsonText('{"payload":{"n":1},"payload":{"n":2},"signature":"aa"}');
    expect(envelope.ok).toBe(false);
    if (!envelope.ok && envelope.code === 'duplicate_json_key') {
      expect(envelope.payloadValues).toEqual([{ n: 1 }, { n: 2 }]);
    }

    // The source must contain a backslash. A JS \u escape would already be "a".
    const escaped = parseJsonText('{"a":1,"\\u0061":2}');
    expect(escaped.ok).toBe(false);
    if (!escaped.ok && escaped.code === 'duplicate_json_key') expect(escaped.value).toEqual({ a: 2 });

    const proto = parseJsonText('{"__proto__":{"admin":true},"__proto__":{"admin":false}}');
    expect(proto.ok).toBe(false);
    if (!proto.ok && proto.code === 'duplicate_json_key') {
      const value = proto.value as Record<string, unknown>;
      expect(value.admin).toBeUndefined();
      expect(Object.hasOwn(value, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    }
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
  });

  it('is the module both the server and the portable verifier import', () => {
    const server = readFileSync(join(process.cwd(), 'src', 'signed-evidence.ts'), 'utf8');
    const portable = readFileSync(join(process.cwd(), 'scripts', 'verify-receipt.mjs'), 'utf8');
    expect(server).toContain("from './json-duplicate-keys.mjs'");
    expect(portable).toContain("from '../src/json-duplicate-keys.mjs'");
    expect(server).not.toContain('function parseJsonText');
    expect(portable).not.toContain('function parseJsonText');
  });

  it.each([
    {
      name: 'top-level duplicate inside the payload',
      json: '{"payload":{"approves_release_sha256":"aa","approves_release_sha256":"bb"},"signature":"cc"}',
      verification: 'optional' as const,
      verdict: 'BLOCK' as const,
    },
    {
      name: 'nested duplicate inside an approval payload',
      json: '{"payload":{"approves_release_sha256":"aa","child":{"b":1,"b":2}},"signature":"cc"}',
      verification: 'optional' as const,
      verdict: 'BLOCK' as const,
    },
    {
      name: 'envelope hides an approval behind a second payload',
      json: '{"payload":{"approves_release_sha256":"aa"},"payload":{"note":"later"},"signature":"cc"}',
      verification: 'optional' as const,
      verdict: 'BLOCK' as const,
      lastKeyDropsApproval: true,
    },
    {
      name: 'keys that differ only by escaping',
      json: '{"payload":{"a":1,"\\u0061":2,"approves_release_sha256":"aa"},"signature":"cc"}',
      verification: 'optional' as const,
      verdict: 'BLOCK' as const,
    },
    {
      name: 'duplicate __proto__ keys inside an approval',
      json: '{"payload":{"__proto__":{"version":"1.4.0"},"__proto__":{"version":"1.4.1"},"approves_release_sha256":"aa"},"signature":"cc"}',
      verification: 'optional' as const,
      verdict: 'BLOCK' as const,
    },
    {
      name: 'required non-approval evidence',
      json: '{"payload":{"note":"one","note":"two"},"signature":"cc"}',
      verification: 'required' as const,
      verdict: 'BLOCK' as const,
    },
  ])('$name is rejected the same way on the server and in the portable verifier', (spec) => {
    if (spec.lastKeyDropsApproval) {
      const collapsed = JSON.parse(spec.json) as { payload: Record<string, unknown> };
      expect(Object.hasOwn(collapsed.payload, 'approves_release_sha256')).toBe(false);
    }
    const request = requestFor(itemFromRawJson(spec.json, spec.verification));
    const server = settle(request);
    const portable = runPortable(request, server.response);
    const evidence = server.processed.evidenceVerification[0];
    expect(server.response.verdict).toBe(spec.verdict);
    expect(evidence?.status).toBe('failed');
    expect(evidence?.code).toBe('duplicate_json_key');
    expect(portable.status, trace(portable)).toBe(1);
    expect(portable.items[0].status).toBe('failed');
    expect(portable.items[0].code).toBe(evidence?.code);
    expect(portable.items[0].signature.status).toBe('not_checked');
    expect(portable.items[0].binding.status).toBe('not_checked');
    expect(portable.items[0].authority.status).toBe('not_checked');
  });

  it('does not force BLOCK for optional non-approval evidence, and the portable verifier still exits 1', () => {
    const json = '{"payload":{"note":"one","note":"two"},"signature":"cc"}';
    const request = requestFor(itemFromRawJson(json, 'optional'));
    const server = settle(request);
    const portable = runPortable(request, server.response);
    expect(server.processed.shouldForceVerdict).toBe(false);
    expect(server.response.verdict).toBe('ALLOW');
    expect(server.processed.evidenceVerification[0].code).toBe('duplicate_json_key');
    expect(server.processed.evidenceVerification[0].status).toBe('failed');
    expect(portable.status, trace(portable)).toBe(1);
    expect(portable.items[0].code).toBe('duplicate_json_key');
    expect(portable.items[0].status).toBe('failed');
  });

  it('still accepts unique signed evidence, including one own __proto__ key', () => {
    const payload = JSON.parse('{"note":"ordinary","__proto__":{"version":"1.4.0"}}') as Record<string, unknown>;
    expect(Object.hasOwn(payload, '__proto__')).toBe(true);
    const request = requestFor(signedUnique(payload));
    const server = settle(request);
    const portable = runPortable(request, server.response);
    expect(server.response.verdict).toBe('ALLOW');
    expect(server.processed.evidenceVerification[0].status).toBe('recomputed');
    expect(server.processed.evidenceVerification[0].code).toBeUndefined();
    expect(portable.status, trace(portable)).toBe(0);
    expect(portable.items[0].status).toBe('recomputed');
    expect(portable.items[0].code).toBeNull();
    expect(portable.items[0].binding.status).toBe('not_checked');
  });

  it('scans deep unique documents without throwing', () => {
    let nested = '{"leaf":1}';
    for (let depth = 0; depth < 8000; depth += 1) nested = `{"k":${nested}}`;
    const arrays = `${'['.repeat(15000)}0${']'.repeat(15000)}`;
    expect(() => parseJsonText(nested)).not.toThrow();
    expect(() => parseJsonText(arrays)).not.toThrow();
    const objects = parseJsonText(nested);
    const padded = parseJsonText(arrays);
    expect(objects.ok).toBe(true);
    expect(padded.ok).toBe(true);
    if (objects.ok) {
      let node = objects.value as { k?: unknown; leaf?: number };
      for (let depth = 0; depth < 8000; depth += 1) node = node.k as { k?: unknown; leaf?: number };
      expect(node.leaf).toBe(1);
    }
    if (padded.ok) {
      let node: unknown = padded.value;
      let depth = 0;
      while (Array.isArray(node)) {
        depth += 1;
        node = node[0];
      }
      expect(depth).toBe(15000);
      expect(node).toBe(0);
    }
  });

  it('rejects a duplicate key nested past the old call-stack limit', () => {
    let nested = '{"a":1,"a":2}';
    for (let depth = 0; depth < 8000; depth += 1) nested = `{"k":${nested}}`;
    expect(() => parseJsonText(nested)).not.toThrow();
    const parsed = parseJsonText(nested);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('duplicate_json_key');

    const payload = { approves_release_sha256: 'aa' };
    const signature = signPayload(payload);
    const raw = `{"payload":${JSON.stringify(payload)},"signature":"${signature}","deep":${nested}}`;
    const request = requestFor(itemFromRawJson(raw));
    const server = settle(request);
    const portable = runPortable(request, server.response);
    expect(server.response.verdict).toBe('BLOCK');
    expect(server.processed.evidenceVerification[0].code).toBe('duplicate_json_key');
    expect(portable.status, trace(portable)).toBe(1);
    expect(portable.items[0].code).toBe('duplicate_json_key');
  });

  it('keeps an outer approval marker blocking when the envelope is deeply nested', () => {
    const payload = { note: 'not an approval shape' };
    const signature = signPayload(payload);
    const padding = `${'['.repeat(8000)}0${']'.repeat(8000)}`;
    const raw = `{"payload":${JSON.stringify(payload)},"signature":"${signature}","padding":${padding}}`;
    const request = requestFor(itemFromRawJson(raw, 'optional', ['approves_release_sha256']));
    const server = settle(request);
    const portable = runPortable(request, server.response);
    expect(server.processed.shouldForceVerdict).toBe(true);
    expect(server.response.verdict).toBe('BLOCK');
    expect(server.processed.evidenceVerification[0].code).toBe('action_binding_digest_not_signed');
    expect(portable.status, trace(portable)).toBe(1);
    expect(portable.items[0].code).toBe('action_binding_digest_not_signed');
  });

  it('accepts a flat matching approval wrapped in 15000 nested padding arrays', () => {
    const release =
      '{"artifact":"buzz-agent","artifact_sha256":"3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b","step":"deploy","target":"production","version":"1.4.0","workflow":"WF-release"}';
    const digest = createHash('sha256').update(release, 'utf8').digest('hex');
    const payload = {
      approves_release_sha256: digest,
      decision: 'ich signiere',
      step: 'deploy',
      type: 'approval',
      workflow: 'WF-release',
    };
    const signature = signPayload(payload);
    const padding = `${'['.repeat(15000)}0${']'.repeat(15000)}`;
    const raw = `{"payload":${JSON.stringify(payload)},"signature":"${signature}","padding":${padding}}`;
    expect(raw.length).toBeGreaterThan(30000);
    const request = accept({
      claim: 'Deploy buzz-agent',
      evidence: 'Deep padding around a flat signed approval. No engine was run.',
      mode: 'action_authorization',
      tier: 'standard',
      proposed_action: release,
      signed_evidence: [itemFromRawJson(raw)],
      key_manifest: {
        version: 'test',
        keys: [{ pubkey: key.pubkeyHex, status: 'active', roles: ['release_approval'] }],
      },
    });
    const server = settle(request);
    const portable = runPortable(request, server.response);
    const evidence = server.processed.evidenceVerification[0];
    expect(server.response.verdict).toBe('ALLOW');
    expect(evidence?.status).toBe('recomputed');
    expect(evidence?.code ?? null).toBeNull();
    expect(portable.status, trace(portable)).toBe(0);
    expect(portable.items[0].status).toBe('recomputed');
    expect(portable.items[0].code).toBe(evidence?.code ?? null);
  });
});
