import { describe, expect, it } from 'vitest';
import {
  buildCanonicalSentinelVerdict,
  serializeCanonicalSentinelVerdict,
  hashCanonicalSentinelVerdict,
} from './canonical-verdict.js';
import type { SentinelVerifyResponse } from './types.js';

function makeResponse(overrides: Partial<SentinelVerifyResponse> = {}): SentinelVerifyResponse {
  return {
    id: 'sent_abc123',
    verdict: 'ALLOW',
    confidence: 0.84,
    reasoning: 'All steps adequately supported by the evidence.',
    objections: [
      {
        step_id: 'step_0',
        criterion: 'Direction check',
        score: 0.91,
        predicate: 'supported',
        quote: 'BTC above 20d MA',
        reasoning: 'Direction claim verified against market data.',
      },
    ],
    mode: 'trade_execution',
    tier: 'standard',
    meta: {
      duration_ms: 3200,
      models_used: ['serv-nano', 'serv-swift'],
      verified_at: '2026-07-01T16:32:00.000Z',
    },
    ...overrides,
  };
}

describe('CanonicalSentinelVerdict', () => {
  it('builds a body with the correct schema tag', () => {
    const body = buildCanonicalSentinelVerdict(makeResponse());
    expect(body.artifactSchema).toBe('sentinel.verdict.canonical.v1');
    expect(body.verificationId).toBe('sent_abc123');
    expect(body.verdict).toBe('ALLOW');
    expect(body.confidence).toBe(84); // 0.84 → 84
    expect(body.tier).toBe('standard');
    expect(body.mode).toBe('trade_execution');
  });

  it('maps objections to deterministic strings', () => {
    const body = buildCanonicalSentinelVerdict(makeResponse());
    expect(body.objections).toEqual(['step_0: Direction claim verified against market data.']);
  });

  it('maps models with primary + secondary', () => {
    const body = buildCanonicalSentinelVerdict(makeResponse());
    expect(body.models.primary).toBe('serv-nano');
    expect(body.models.secondary).toBe('serv-swift');
  });

  it('omits secondary when only one model ran (solo tier)', () => {
    const body = buildCanonicalSentinelVerdict(
      makeResponse({
        meta: { duration_ms: 900, models_used: ['serv-nano'], verified_at: '2026-07-01T16:32:00.000Z' },
      }),
    );
    expect(body.models.primary).toBe('serv-nano');
    expect(body.models.secondary).toBeUndefined();
  });

  it('omits gate when not present (JCS: absent ≠ null)', () => {
    const body = buildCanonicalSentinelVerdict(makeResponse());
    expect(body.gate).toBeUndefined();
  });

  it('includes gate when present (action_authorization)', () => {
    const body = buildCanonicalSentinelVerdict(
      makeResponse({
        mode: 'action_authorization',
        gate: {
          mode: 'enforce',
          wouldBlock: false,
          enforced: true,
          violations: [],
        },
      }),
    );
    expect(body.gate).toBeDefined();
    expect(body.gate!.mode).toBe('enforce');
    expect(body.gate!.violations).toEqual([]);
  });

  // ⭐ The core recomputability test: same input → identical bytes → identical hash.
  it('JCS determinism: same response produces identical serialized bytes + hash', () => {
    const resp = makeResponse();
    const body1 = buildCanonicalSentinelVerdict(resp);
    const body2 = buildCanonicalSentinelVerdict(resp);
    const bytes1 = serializeCanonicalSentinelVerdict(body1);
    const bytes2 = serializeCanonicalSentinelVerdict(body2);
    const hash1 = hashCanonicalSentinelVerdict(body1);
    const hash2 = hashCanonicalSentinelVerdict(body2);
    expect(bytes1).toBe(bytes2);
    expect(hash1).toBe(hash2);
    // hash is 0x-prefixed sha256 (66 chars)
    expect(hash1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('different verdicts produce different hashes', () => {
    const allow = buildCanonicalSentinelVerdict(makeResponse({ verdict: 'ALLOW' }));
    const block = buildCanonicalSentinelVerdict(makeResponse({ verdict: 'BLOCK' }));
    expect(hashCanonicalSentinelVerdict(allow)).not.toBe(hashCanonicalSentinelVerdict(block));
  });

  it('serialized output is valid JSON (recomputable by any third party)', () => {
    const body = buildCanonicalSentinelVerdict(makeResponse());
    const serialized = serializeCanonicalSentinelVerdict(body);
    const parsed = JSON.parse(serialized);
    expect(parsed.artifactSchema).toBe('sentinel.verdict.canonical.v1');
    expect(parsed.verdict).toBe('ALLOW');
  });
});
