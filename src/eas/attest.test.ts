/**
 * Tests for EAS Attestation Service
 *
 * Tests the pure functions (buildAttestationData, encodeAttestationData, hashToBytes32).
 * Does NOT test issueAttestation (requires chain connection).
 */

import { describe, it, expect } from 'vitest';
import { buildAttestationData, encodeAttestationData, hashToBytes32 } from './attest.js';
import type { SentinelVerifyRequest, SentinelVerifyResponse } from '../types.js';

describe('hashToBytes32', () => {
  it('returns a 66-char hex string (0x + 64)', () => {
    const hash = hashToBytes32('hello world');
    expect(hash).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('returns deterministic hashes', () => {
    const a = hashToBytes32('test claim');
    const b = hashToBytes32('test claim');
    expect(a).toBe(b);
  });

  it('returns different hashes for different inputs', () => {
    const a = hashToBytes32('claim A');
    const b = hashToBytes32('claim B');
    expect(a).not.toBe(b);
  });
});

describe('buildAttestationData', () => {
  const mockReq: SentinelVerifyRequest = {
    claim: 'Agent output is coherent with handoff context',
    evidence: 'Handoff packet: {task: "summarize", context: "meeting notes"}',
    mode: 'handoff',
    tier: 'standard',
  };

  const mockRes: SentinelVerifyResponse = {
    id: 'sent_abc123',
    verdict: 'ALLOW',
    confidence: 0.875,
    reasoning: 'Output aligns with handoff context.',
    objections: [],
    mode: 'handoff',
    tier: 'standard',
    meta: {
      duration_ms: 1200,
      models_used: ['serv-nano', 'serv-pro'],
      verified_at: '2026-05-13T18:30:00.000Z',
    },
  };

  it('builds correct attestation data', () => {
    const data = buildAttestationData(mockReq, mockRes);

    expect(data.verificationId).toBe('sent_abc123');
    expect(data.qualified).toBe(true); // ALLOW → true
    expect(data.qualification).toBe('sentinel_qualified');
    expect(data.apiVersion).toBe('0.1.0');
    expect(data.tier).toBe('standard');
    expect(data.mode).toBe('handoff');
    expect(data.verdict).toBe('ALLOW');
    expect(data.confidence).toBe(88); // 0.875 * 100 rounded
    expect(data.claimHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(data.evidenceHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(data.evaluatedAt).toBe(Math.floor(new Date('2026-05-13T18:30:00.000Z').getTime() / 1000));
  });

  it('sets qualified=false for BLOCK verdict', () => {
    const blockRes = { ...mockRes, verdict: 'BLOCK' as const };
    const data = buildAttestationData(mockReq, blockRes);
    expect(data.qualified).toBe(false);
  });

  it('sets qualified=false for UNCERTAIN verdict', () => {
    const uncertainRes = { ...mockRes, verdict: 'UNCERTAIN' as const };
    const data = buildAttestationData(mockReq, uncertainRes);
    expect(data.qualified).toBe(false);
  });

  it('hashes claim and evidence separately', () => {
    const data = buildAttestationData(mockReq, mockRes);
    expect(data.claimHash).not.toBe(data.evidenceHash);
  });
});

describe('encodeAttestationData', () => {
  it('returns valid ABI-encoded hex string', async () => {
    const data = buildAttestationData(
      {
        claim: 'test claim',
        evidence: 'test evidence',
        mode: 'handoff',
        tier: 'checkpoint',
      },
      {
        id: 'sent_test',
        verdict: 'ALLOW',
        confidence: 1.0,
        reasoning: 'test',
        objections: [],
        mode: 'handoff',
        tier: 'checkpoint',
        meta: {
          duration_ms: 500,
          models_used: ['serv-nano'],
          verified_at: '2026-05-13T18:30:00.000Z',
        },
      },
    );

    const encoded = await encodeAttestationData(data);
    expect(encoded).toMatch(/^0x[a-f0-9]+$/);
    // ABI-encoded data should be substantial (multiple fields)
    expect(encoded.length).toBeGreaterThan(200);
  });
});
