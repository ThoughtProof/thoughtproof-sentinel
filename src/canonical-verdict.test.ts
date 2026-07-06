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

  // ⭐ EXTERNAL-ANCHOR REGRESSION: reproduce the committed public fixture
  // byte-exact + its known anchored hash. This is the test that actually
  // protects the separable-attribution property: the fixture in the PUBLIC
  // composed-evaluators/verdict-envelope repo (canonical.json) was recomputed
  // by invinoveritas as sha256 419c360d…; if our builder ever drifts from it,
  // the partner's independent recompute stops matching and the composition
  // breaks. The self-consistency tests above ('same input → same hash') do NOT
  // catch drift away from the committed bytes — only this one does.
  const FIXTURE_JCS =
    '{"apiVersion":"sentinel-api-0.1.0","artifactSchema":"sentinel.verdict.canonical.v1","confidence":84,"evaluatedAt":1782916498,"mode":"trade_execution","models":{"primary":"serv-nano","secondary":"serv-swift"},"objections":["step_0: Direction claim verified against market data."],"reasoning":"All steps adequately supported by the evidence.","tier":"standard","verdict":"ALLOW","verificationId":"sent_9f3c2a7b1e004d68"}';
  const FIXTURE_HASH_0x =
    '0x419c360db82ee72be3411acd2d30f560b3f62842c2162fa3cb4a08c1fa4ce65a';

  // A response engineered to project exactly onto the committed fixture body.
  const fixtureResponse: SentinelVerifyResponse = makeResponse({
    id: 'sent_9f3c2a7b1e004d68',
    confidence: 0.84,
    objections: [
      {
        step_id: 'step_0',
        criterion: 'Direction check',
        score: 0.9,
        predicate: 'supported',
        quote: null,
        reasoning: 'Direction claim verified against market data.',
      },
    ],
    meta: {
      duration_ms: 1200,
      models_used: ['serv-nano', 'serv-swift'],
      verified_at: '2026-07-01T14:34:58.000Z', // floor(/1000) → 1782916498
    },
  });

  it('reproduces the committed verdict-envelope fixture bytes exactly', () => {
    const jcs = serializeCanonicalSentinelVerdict(
      buildCanonicalSentinelVerdict(fixtureResponse),
    );
    expect(jcs).toBe(FIXTURE_JCS);
  });

  it('reproduces the known anchored hash 0x419c360d… (independent recompute target)', () => {
    const hash = hashCanonicalSentinelVerdict(
      buildCanonicalSentinelVerdict(fixtureResponse),
    );
    expect(hash).toBe(FIXTURE_HASH_0x);
  });
});
