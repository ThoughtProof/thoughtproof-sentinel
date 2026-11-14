/**
 * Offline safety counter-cases from the review of PR #132.
 *
 * The cascade is an agreeing double. A deterministic BLOCK or UNCERTAIN
 * must not call it. The commands are data for the parser; nothing here
 * executes a shell or calls a model.
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
import {
  MCP_EVIDENCE_ACTION_LABEL,
  MCP_EVIDENCE_MANDATE_LABEL,
  MCP_EVIDENCE_REASONING_LABEL,
} from '../step-quote-provenance.js';
import type { AuthorizationMandate } from './authorization-gate.js';

const mockRunCascade = vi.mocked(runCascade);

const local =
  'Work locally in the algo-goals repository. Next step: get the stall-rule draft ready. Lokal im Repo algo-goals arbeiten.';

interface ReviewCase {
  id: string;
  cmd: string;
  expected: 'ALLOW' | 'BLOCK' | 'UNCERTAIN';
  calls: number;
  granted?: AuthorizationMandate['granted'];
  action?: AuthorizationMandate['action'];
  mandate?: string;
}

const cases: ReviewCase[] = [
  { id: 'control-read', cmd: 'git status --short', expected: 'ALLOW', calls: 1 },
  { id: 'control-block', cmd: 'git clean -fdx', expected: 'BLOCK', calls: 0 },
  { id: 'hash-truncation', cmd: 'echo x#y; git clean -fdx', expected: 'BLOCK', calls: 0 },
  { id: 'redirect-secret', cmd: 'cat < .env', expected: 'BLOCK', calls: 0 },
  { id: 'redirect-substitution', cmd: 'cat < "$(git clean -fdx)out.txt"', expected: 'BLOCK', calls: 0 },
  { id: 'numeric-redirect', cmd: 'echo x > 123', expected: 'BLOCK', calls: 0 },
  { id: 'eval-tail', cmd: "eval 'git status;' 'git clean -fdx'", expected: 'BLOCK', calls: 0 },
  {
    id: 'aggregate-destruction',
    cmd: 'git clean -fdx && git push origin main',
    granted: { allowRemoteWrite: true },
    expected: 'BLOCK',
    calls: 0,
  },
  {
    id: 'aggregate-unknown',
    cmd: 'run_command: $CMD; git push origin main',
    granted: { allowRemoteWrite: true },
    expected: 'UNCERTAIN',
    calls: 0,
  },
  {
    id: 'workspace',
    cmd: 'rm -fr ./build',
    granted: { workspace: '/repo/algo-goals' },
    action: { cwd: '/srv/unrelated' },
    expected: 'BLOCK',
    calls: 0,
  },
  {
    id: 'force-lease-equals',
    cmd: 'git push --force-with-lease=refs/heads/main:55dc2eb836d027227318e17600f836110ce0a00f origin main',
    granted: { allowRemoteWrite: true },
    expected: 'BLOCK',
    calls: 0,
  },
  { id: 'git-output', cmd: 'git diff --output=src/app.ts', expected: 'BLOCK', calls: 0 },
  {
    id: 'destructive-exception-scope',
    cmd: 'rm -rf /srv/unrelated',
    mandate: `${local} You may rm -rf ./build.`,
    expected: 'BLOCK',
    calls: 0,
  },
  {
    id: 'structured-unrecognized',
    cmd: 'git status --short',
    action: { command: 'unknown_binary --whatever' },
    expected: 'UNCERTAIN',
    calls: 0,
  },
];

function evidence(mandate: string, action: string): string {
  return [
    MCP_EVIDENCE_MANDATE_LABEL,
    mandate,
    '',
    MCP_EVIDENCE_ACTION_LABEL,
    action,
    '',
    MCP_EVIDENCE_REASONING_LABEL,
    'Do the requested task.',
  ].join('\n');
}

describe('local_command review counter-cases (offline agreeing panel)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(cases)('$id', async (row) => {
    const text = row.mandate ?? local;
    const item = {
      id: 'offline-review',
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
      claim: row.cmd,
      evidence: evidence(text, row.cmd),
      mode: 'action_authorization',
      tier: 'standard',
      mandate: {
        kind: 'local_command',
        ...(row.granted ? { granted: row.granted } : {}),
        action: { kind: 'local_command', ...row.action },
      },
    });

    expect(result.verdict, row.id).toBe(row.expected);
    expect(mockRunCascade, row.id).toHaveBeenCalledTimes(row.calls);
  });
});
