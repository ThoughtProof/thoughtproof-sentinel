/**
 * action_authorization mode — issue #33 FYI-ALLOW + Ship-mismatch BLOCK.
 *
 * Criteria tuning for non-financial crew actions. Cascade is mocked
 * (same pattern as engine.test.ts / quote-null-provenance.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pot-cli/plv', () => ({ evaluateItem: vi.fn() }));
vi.mock('pot-cli/cascade', () => ({ runCascade: vi.fn() }));
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
import { actionAuthorization } from './modes/action_authorization.js';
import { MCP_EVIDENCE_ACTION_LABEL, MCP_EVIDENCE_MANDATE_LABEL, MCP_EVIDENCE_REASONING_LABEL } from '../step-quote-provenance.js';
import type { SentinelVerifyRequest } from '../types.js';

const mockRunCascade = vi.mocked(runCascade);

const FYI_MANDATE = 'Tell CoS host runs git main';

function mcpEvidence(mandate: string, action: string, reasoning: string): string {
  return [
    MCP_EVIDENCE_MANDATE_LABEL,
    mandate,
    '',
    MCP_EVIDENCE_ACTION_LABEL,
    action,
    '',
    MCP_EVIDENCE_REASONING_LABEL,
    reasoning,
  ].join('\n');
}

function cascade(verdict: string, reason: string, steps: Array<{
  step_id: string;
  predicate: string;
  score: number;
  quote: string | null;
  reasoning: string;
}>) {
  const item = {
    id: 'aa-33',
    verdict,
    verdict_reasoning: `cascade ${verdict}`,
    step_evaluations: steps,
    provenance_violations: [],
    overall_score: steps.reduce((a, s) => a + s.score, 0) / (steps.length || 1),
    tier1_stats: undefined,
  };
  return {
    verdict,
    reason,
    primary: item,
    secondary: item,
    primaryModel: 'nano',
    secondaryModel: 'swift',
    secondaryInvoked: true,
    degradedMode: false,
    errors: [],
    totalLatencyMs: 120,
  };
}

describe('action_authorization gold steps (issue #33 criteria)', () => {
  it('encodes informational PASS and financial FAIL on the same four steps', () => {
    const out = actionAuthorization({
      id: 't',
      claim: 'The proposed FYI to CoS is authorized by the mandate.',
      evidence: mcpEvidence(FYI_MANDATE, FYI_MANDATE, 'FYI to CoS'),
      mode: 'action_authorization',
    });
    const steps = out.evalInput.gold_plan_steps;
    expect(steps).toHaveLength(4);
    const c0 = steps[0]!.acceptance_criterion.toLowerCase();
    const c1 = steps[1]!.acceptance_criterion.toLowerCase();
    const c2 = steps[2]!.acceptance_criterion.toLowerCase();
    const c3 = steps[3]!.acceptance_criterion.toLowerCase();

    expect(c0).toMatch(/informational|fyi|status ping/);
    expect(c0).toMatch(/identifiers|issue numbers/);
    expect(c0).toMatch(/max_uint256|unlimited/);
    expect(c1).toMatch(/chief of staff|named recipient|teammate/);
    expect(c1).toMatch(/wallet address is not required/);
    expect(c2).toMatch(/ship|npm|deploy/);
    expect(c2).toMatch(/objective_mismatch|notify/);
    expect(c3).toMatch(/fyi|status ping|notify/);
    expect(c3).toMatch(/unlimited approval/);

    expect(out.evalInput.trace_steps).toMatch(/^structural_fact:/);
    expect(out.evalInput.question.toLowerCase()).toMatch(/informational crew action/);
  });

  it('does not annotate wallet-drain evidence as informational', () => {
    const out = actionAuthorization({
      id: 't',
      claim: 'Granting unlimited approval is in-scope.',
      evidence:
        'USER INSTRUCTION: Swap 100 USDC for ETH.\n' +
        'AGENT PROPOSED ACTION: approve(UniversalRouter, MAX_UINT256)\n' +
        'AGENT REASONING: saves gas',
      mode: 'action_authorization',
    });
    expect(out.evalInput.trace_steps.startsWith('structural_fact:')).toBe(false);
    expect(out.evalInput.gold_plan_steps[0].acceptance_criterion).toMatch(
      /MAX_UINT256/,
    );
  });
});

describe('action_authorization engine — FYI ALLOW + Ship BLOCK', () => {
  beforeEach(() => vi.clearAllMocks());

  it('FYI-aligned all-steps-pass → public ALLOW (no provenance artifact)', async () => {
    const evidence = mcpEvidence(
      FYI_MANDATE,
      FYI_MANDATE,
      'FYI to CoS that the host is running on git main.',
    );
    mockRunCascade.mockResolvedValueOnce(
      cascade('ALLOW', 'agreement_allow', [
        { step_id: 'step_0', predicate: 'faithful', score: 0.9, quote: FYI_MANDATE, reasoning: 'No spend scope to exceed.' },
        { step_id: 'step_1', predicate: 'faithful', score: 0.9, quote: FYI_MANDATE, reasoning: 'CoS is the mandate recipient.' },
        { step_id: 'step_2', predicate: 'faithful', score: 0.9, quote: FYI_MANDATE, reasoning: 'Action is the instructed FYI.' },
        { step_id: 'step_3', predicate: 'faithful', score: 0.85, quote: FYI_MANDATE, reasoning: 'Notify is minimally scoped.' },
      ]) as never,
    );

    const req: SentinelVerifyRequest = {
      claim: 'The proposed FYI to CoS is authorized by the mandate.',
      evidence,
      mode: 'action_authorization',
      tier: 'standard',
    };
    const res = await verify(req);

    expect(res.verdict).toBe('ALLOW');
    expect(JSON.stringify(res)).not.toMatch(/undefined\s*\[PROVENANCE/i);
    expect(res.objections.every((o) => !/PROVENANCE DOWNGRADE/i.test(o.reasoning))).toBe(
      true,
    );
    const evalInput = mockRunCascade.mock.calls[0][0] as {
      gold_plan_steps: unknown[];
      trace_steps: string;
    };
    expect(evalInput.gold_plan_steps).toHaveLength(4);
    expect(evalInput.trace_steps).toMatch(/action_kind=informational/);
  });

  it('Ship-mismatch stays BLOCK on scope/objective (not provenance)', async () => {
    const mandate =
      'Ship the release only after pinning the npm version and CI is green.';
    const evidence = mcpEvidence(
      mandate,
      'Notify CoS that we are shipping now.',
      'Notify chief of staff; do not pin npm or wait for CI.',
    );
    mockRunCascade.mockResolvedValueOnce(
      cascade('BLOCK', 'agreement_block', [
        {
          step_id: 'step_0',
          predicate: 'unfaithful',
          score: 0,
          quote: null,
          reasoning: 'Notify is not the granted ship/pin scope.',
        },
        {
          step_id: 'step_1',
          predicate: 'unfaithful',
          score: 0,
          quote: null,
          reasoning: 'CoS was not the authorized ship/pin target.',
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

    expect(res.verdict).toBe('BLOCK');
    const reasons = res.objections.map((o) => o.reasoning).join(' ');
    expect(reasons).toMatch(/scope|objective|npm pin|ship/i);
    expect(JSON.stringify(res)).not.toMatch(/undefined\s*\[PROVENANCE/i);
    const evalInput = mockRunCascade.mock.calls[0][0] as { trace_steps: string };
    expect(evalInput.trace_steps).toMatch(/objective_mismatch=true/);
  });
});
