/**
 * Engine-level regression: quote:null + weakly_faithful dogfood (2026-09-09).
 *
 * Mocks pot-cli cascade the same way engine.test.ts does so we assert the
 * Sentinel surface contract without a live SERV call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pot-cli/plv', () => ({
  evaluateItem: vi.fn(),
}));

vi.mock('pot-cli/cascade', () => ({
  runCascade: vi.fn(),
}));

vi.mock('pot-cli/verdict', () => ({
  toPublicVerdict: vi.fn((internal: string) => {
    const map: Record<string, string> = {
      ALLOW: 'ALLOW',
      CONDITIONAL_ALLOW: 'ALLOW',
      HOLD: 'UNCERTAIN',
      BLOCK: 'BLOCK',
      DISSENT: 'UNCERTAIN',
    };
    return {
      verdict: map[internal] ?? 'UNCERTAIN',
      metadata: { schema_version: 'v2', confidence: 'high' },
    };
  }),
}));

import { verify } from './index.js';
import { runCascade } from 'pot-cli/cascade';
import { isEvidenceSubstring } from '../step-quote-provenance.js';
import type { SentinelVerifyRequest } from '../types.js';

const mockRunCascade = vi.mocked(runCascade);

const FYI_MANDATE = 'Tell CoS host runs git main';

function mcpEvidence(mandate: string, action: string, reasoning: string): string {
  return [
    'Principal mandate (verbatim quote):',
    mandate,
    '',
    'Proposed action:',
    action,
    '',
    'Agent reasoning:',
    reasoning,
  ].join('\n');
}

function cascadeWithSteps(
  verdict: string,
  steps: Array<{
    step_id: string;
    predicate: string;
    score: number;
    quote: string | null;
    reasoning: string | undefined;
  }>,
) {
  const item = {
    id: 'aa-dogfood',
    verdict,
    verdict_reasoning: `cascade ${verdict}`,
    step_evaluations: steps,
    provenance_violations: [],
    overall_score: steps.reduce((a, s) => a + s.score, 0) / (steps.length || 1),
    tier1_stats: undefined,
  };
  return {
    verdict,
    reason: verdict === 'BLOCK' ? 'agreement_block' : 'agreement_hold',
    primary: item,
    secondary: item,
    primaryModel: 'nano',
    secondaryModel: 'swift',
    secondaryInvoked: true,
    degradedMode: false,
    errors: [],
    totalLatencyMs: 200,
  };
}

describe('action_authorization quote:null provenance (dogfood 2026-09-09)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('FYI-aligned: weakly_faithful + quote null must not emit undefined [PROVENANCE', async () => {
    const evidence = mcpEvidence(
      FYI_MANDATE,
      FYI_MANDATE,
      'FYI to CoS that the host is running on git main.',
    );

    mockRunCascade.mockResolvedValueOnce(
      cascadeWithSteps('HOLD', [
        {
          step_id: 'step_0',
          predicate: 'weakly_faithful',
          score: 0.25,
          quote: null,
          reasoning: 'undefined [PROVENANCE DOWNGRADE: quote invalid or missing]',
        },
        {
          step_id: 'step_1',
          predicate: 'weakly_faithful',
          score: 0.25,
          quote: null,
          reasoning: undefined,
        },
        {
          step_id: 'step_2',
          predicate: 'weakly_faithful',
          score: 0.25,
          quote: null,
          reasoning: 'undefined [PROVENANCE DOWNGRADE: quote invalid or missing]',
        },
        {
          step_id: 'step_3',
          predicate: 'weakly_faithful',
          score: 0.25,
          quote: null,
          reasoning: 'undefined [PROVENANCE DOWNGRADE: quote invalid or missing]',
        },
      ]) as never,
    );

    const req: SentinelVerifyRequest = {
      claim: 'The proposed FYI to CoS is authorized by the mandate.',
      evidence,
      mode: 'action_authorization',
      tier: 'standard',
    };

    const res = await verify(req);

    const blob = JSON.stringify(res);
    expect(blob).not.toMatch(/undefined\s*\[PROVENANCE/i);

    expect(res.objections.length).toBe(4);
    for (const obj of res.objections) {
      expect(obj.reasoning).not.toMatch(/undefined\s*\[PROVENANCE/i);
      expect(obj.reasoning.length).toBeGreaterThan(0);
      if (obj.quote !== null) {
        expect(isEvidenceSubstring(obj.quote, evidence)).toBe(true);
      }
    }
    // MCP already supplied a citeable mandate span — recover it on near-pass.
    expect(res.objections.some((o) => o.quote === FYI_MANDATE)).toBe(true);
    expect(res.objections.every((o) => !o.reasoning.includes('PROVENANCE DOWNGRADE'))).toBe(
      true,
    );
    const recovered = res.objections.filter((o) => o.quote === FYI_MANDATE);
    expect(recovered.length).toBeGreaterThan(0);
    for (const obj of recovered) {
      expect(obj.quote_source).toBe('recovered_mandate');
      expect(obj.reasoning.toLowerCase()).toContain(
        'provenance recovered from host mandate span',
      );
    }
  });

  it('Ship-mismatch: fail-closed on scope/objective, not only provenance', async () => {
    const mandate =
      'Ship the release only after pinning the npm version and CI is green.';
    const evidence = mcpEvidence(
      mandate,
      'Notify CoS that we are shipping now.',
      'Notify chief of staff; do not pin npm or wait for CI.',
    );

    mockRunCascade.mockResolvedValueOnce(
      cascadeWithSteps('BLOCK', [
        {
          step_id: 'step_0',
          predicate: 'unfaithful',
          score: 0,
          quote: null,
          reasoning:
            'Action notifies CoS; mandate is about npm pin / ship — exceeds granted scope.',
        },
        {
          step_id: 'step_1',
          predicate: 'unfaithful',
          score: 0,
          quote: null,
          reasoning: 'Recipient is CoS; mandate authorized a ship/pin action, not a notify.',
        },
        {
          step_id: 'step_2',
          predicate: 'unfaithful',
          score: 0,
          quote: null,
          reasoning:
            'Action serves an FYI objective; mandate instructed shipping after npm pin.',
        },
        {
          step_id: 'step_3',
          predicate: 'unfaithful',
          score: 0,
          quote: null,
          reasoning: 'Notify is not the least-privilege fulfillment of the ship mandate.',
        },
      ]) as never,
    );

    const res = await verify({
      claim: 'Notifying CoS is authorized by the ship/pin mandate.',
      evidence,
      mode: 'action_authorization',
      tier: 'standard',
    });

    const blob = JSON.stringify(res);
    expect(blob).not.toMatch(/undefined\s*\[PROVENANCE/i);

    expect(res.verdict).toBe('BLOCK');
    const reasons = res.objections.map((o) => o.reasoning).join(' ');
    expect(reasons).toMatch(/scope|objective|npm pin|ship/i);
    expect(reasons).not.toMatch(/PROVENANCE DOWNGRADE/);
    // Fail-closed on real criteria, not a provenance-only stamp.
    const provenanceOnly = res.objections.every((o) =>
      /PROVENANCE DOWNGRADE|citeable substring/i.test(o.reasoning),
    );
    expect(provenanceOnly).toBe(false);
    for (const obj of res.objections) {
      if (obj.quote !== null) {
        expect(isEvidenceSubstring(obj.quote, evidence)).toBe(true);
        expect(obj.quote_source).toBe('recovered_mandate');
      }
    }
  });
});
