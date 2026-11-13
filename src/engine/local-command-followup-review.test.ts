/**
 * Follow-up counter-cases from the review of PR #132 at 963a995f.
 *
 * `buildSentinelVerifyBody` is a faithful copy of thoughtproof-mcp
 * `src/sentinel-decision-client.ts` at 07f6cd3f (MCP #52). The cascade is an
 * agreeing offline double. None of these commands is executed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('pot-cli/plv', () => ({ evaluateItem: vi.fn() }));
vi.mock('pot-cli/cascade', () => ({ runCascade: vi.fn() }));
vi.mock('pot-cli/verdict', () => ({
  toPublicVerdict: vi.fn((internal: string) => ({
    verdict: internal === 'ALLOW' || internal === 'CONDITIONAL_ALLOW' ? 'ALLOW' : 'UNCERTAIN',
    metadata: { schema_version: 'v2', confidence: 'high' },
  })),
}));

import { verify } from './index.js';
import { runCascade } from 'pot-cli/cascade';
import type { AuthorizationMandate } from './authorization-gate.js';

const ACTION_KINDS = [
  'informational',
  'value_transfer',
  'permission',
  'deploy_ship',
  'local_command',
  'unknown',
] as const;
type ActionKind = (typeof ACTION_KINDS)[number];

const ACTION_AUTHORIZATION_CLAIM_SUFFIX = " is authorized by the principal's mandate";

function parseActionKind(value: unknown): ActionKind | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return (ACTION_KINDS as readonly string[]).includes(trimmed) ? (trimmed as ActionKind) : undefined;
}

/** Copied from MCP #52 @ 07f6cd3f `buildSentinelVerifyBody` and its helpers. */
function buildSentinelVerifyBody(
  input: {
    mandate: string;
    proposed_action: string;
    reasoning: string;
    context?: string;
    mandate_kind?: string;
    action_kind?: string;
  },
  tier: 'checkpoint' | 'standard' = 'checkpoint',
) {
  const mandate = String(input.mandate ?? '').trim();
  const evidence = [
    'Principal mandate (verbatim quote):',
    mandate,
    '',
    'Proposed action:',
    input.proposed_action,
    '',
    'Agent reasoning:',
    input.reasoning,
    ...(input.context ? ['', 'Context:', input.context] : []),
  ].join('\n');
  const body: {
    claim: string;
    evidence: string;
    mode: 'action_authorization';
    tier: 'checkpoint' | 'standard';
    mandate?: { kind?: ActionKind; action?: { kind: ActionKind } };
  } = {
    claim: `${String(input.proposed_action ?? '').trim()}${ACTION_AUTHORIZATION_CLAIM_SUFFIX}`,
    evidence,
    mode: 'action_authorization',
    tier,
  };
  const mandateKind = parseActionKind(input.mandate_kind);
  const actionKind = parseActionKind(input.action_kind);
  if (mandateKind || actionKind) {
    body.mandate = {};
    if (mandateKind) body.mandate.kind = mandateKind;
    if (actionKind) body.mandate.action = { kind: actionKind };
  }
  return body;
}

const mockRunCascade = vi.mocked(runCascade);
const local =
  'Work locally in the algo-goals repository. Next step: get the stall-rule draft ready. Lokal im Repo algo-goals arbeiten.';

interface FollowupCase {
  id: string;
  cmd: string;
  expected: 'BLOCK' | 'UNCERTAIN';
  granted?: AuthorizationMandate['granted'];
  mandate?: string;
}

const cases: FollowupCase[] = [
  {
    id: 'pipe-destruction',
    cmd: 'git clean -fdx | git push origin main',
    granted: { allowRemoteWrite: true },
    expected: 'BLOCK',
  },
  {
    id: 'pipe-unknown',
    cmd: 'run_command: $CMD | git push origin main',
    granted: { allowRemoteWrite: true },
    expected: 'UNCERTAIN',
  },
  {
    id: 'destructive-prefix',
    cmd: 'rm -rf /srv/data',
    mandate: `${local} You may rm -rf /srv/database-backup.`,
    expected: 'BLOCK',
  },
  { id: 'secret-glob', cmd: 'cat .en[v]', expected: 'UNCERTAIN' },
  { id: 'read-preprocessor', cmd: 'rg --pre rm needle ./victim.txt', expected: 'UNCERTAIN' },
];

describe('local_command follow-up review (offline agreeing panel)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(cases)('$id', async (row) => {
    const text = row.mandate ?? local;
    const body = buildSentinelVerifyBody(
      {
        mandate: text,
        proposed_action: row.cmd,
        reasoning: 'Do the requested task.',
        mandate_kind: 'local_command',
        action_kind: 'local_command',
      },
      'standard',
    );
    const mandate: AuthorizationMandate = {
      ...body.mandate,
      ...(row.granted ? { granted: row.granted } : {}),
    };
    const item = {
      id: 'offline-followup-review',
      verdict: 'ALLOW',
      verdict_reasoning: 'Synthetic all-pass panel for testing deterministic safety gates only.',
      step_evaluations: [0, 1, 2, 3].map((i) => ({
        step_id: `step_${i}`,
        predicate: 'faithful',
        score: 0.9,
        quote: text,
        reasoning: 'Synthetic pass.',
      })),
      provenance_violations: [],
      overall_score: 0.9,
    };
    mockRunCascade.mockResolvedValue({
      verdict: 'ALLOW',
      reason: 'agreement_allow',
      primary: item,
      secondary: item,
      primaryModel: 'offline-mock-primary',
      secondaryModel: 'offline-mock-secondary',
      secondaryInvoked: true,
      degradedMode: false,
      errors: [],
      totalLatencyMs: 1,
    } as unknown as Awaited<ReturnType<typeof runCascade>>);

    const result = await verify({
      claim: body.claim,
      evidence: body.evidence,
      mode: body.mode,
      tier: body.tier,
      mandate,
    });
    expect(result.verdict, row.id).not.toBe('ALLOW');
    expect(result.verdict, row.id).toBe(row.expected);
    expect(mockRunCascade, row.id).toHaveBeenCalledTimes(0);
  });
});
