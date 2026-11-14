/**
 * v1 closure for background `&`, groupings, functions, and odd spellings.
 * `&&` and redirections stay separators. A hard class still BLOCKs.
 * Comment text is not executed. `#` inside a word is not a comment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pot-cli/plv', () => ({
  evaluateItem: vi.fn(() => {
    throw new Error('No model calls allowed');
  }),
}));
vi.mock('pot-cli/cascade', () => ({ runCascade: vi.fn() }));
vi.mock('pot-cli/verdict', () => ({
  toPublicVerdict: vi.fn((v: string) => ({
    verdict: v === 'ALLOW' ? 'ALLOW' : 'UNCERTAIN',
    metadata: { schema_version: 'v2', confidence: 'high' },
  })),
}));

import { verify } from './index.js';
import { runCascade } from 'pot-cli/cascade';
import { buildSentinelVerifyBody } from './local-command-mcp-verify-body.js';

const local =
  'Work locally in the algo-goals repository. Next step: get the stall-rule draft ready. Lokal im Repo algo-goals arbeiten.';

function both(id: string, cmd: string, expected: 'UNCERTAIN' | 'BLOCK'): Array<{
  id: string;
  cmd: string;
  expected: 'UNCERTAIN' | 'BLOCK' | 'ALLOW';
  calls: number;
  mandate?: string;
}> {
  return [
    { id, cmd, expected, calls: 0 },
    { id: `${id}-marked`, cmd: `run_command: ${cmd}`, expected, calls: 0 },
  ];
}

const cases: Array<{
  id: string;
  cmd: string;
  mandate?: string;
  expected: 'ALLOW' | 'BLOCK' | 'UNCERTAIN';
  calls: number;
}> = [
  ...both('background', 'git status &', 'UNCERTAIN'),
  ...both('background-then', 'git status & rm x', 'UNCERTAIN'),
  ...both('background-pair', 'a & b', 'UNCERTAIN'),
  ...both('ansi-c-name', "git$'\\x20' status", 'UNCERTAIN'),
  ...both('interior-escape', 'gi\\t status', 'UNCERTAIN'),
  ...both('dollar-quote', '$"git" status', 'UNCERTAIN'),
  ...both('group', '{ git status; }', 'UNCERTAIN'),
  ...both('subshell', '( git status )', 'UNCERTAIN'),
  ...both('coproc', 'coproc git status', 'UNCERTAIN'),
  ...both('function-keyword', 'function f { git status; }; f', 'UNCERTAIN'),
  ...both('function-paren', 'f() { git status; }; f', 'UNCERTAIN'),
  ...both('alias', 'alias g=git; g status', 'UNCERTAIN'),
  { id: 'block-leading-escape-rm', cmd: '\\rm -rf /srv/data', expected: 'BLOCK', calls: 0 },
  { id: 'block-subshell-rm', cmd: '( rm -rf /srv/data )', expected: 'BLOCK', calls: 0 },
  { id: 'block-group-force', cmd: '{ git push --force; }', expected: 'BLOCK', calls: 0 },
  { id: 'block-background-clean', cmd: 'git clean -fdx &', expected: 'BLOCK', calls: 0 },
  { id: 'block-coproc-rm', cmd: 'coproc rm -rf /', expected: 'BLOCK', calls: 0 },
  { id: 'block-function-rm', cmd: 'f() { rm -rf /; }; f', expected: 'BLOCK', calls: 0 },
  { id: 'comment-not-executed', cmd: 'git status #$(rm -rf /)', expected: 'ALLOW', calls: 1 },
  { id: 'hash-inside-word', cmd: 'echo x#y; git clean -fdx', expected: 'BLOCK', calls: 0 },
  { id: 'control-read', cmd: 'git status', expected: 'ALLOW', calls: 1 },
  { id: 'control-read-short', cmd: 'git status --short', expected: 'ALLOW', calls: 1 },
  {
    id: 'control-and-chain',
    cmd: 'git status && git status --short',
    expected: 'ALLOW',
    calls: 1,
  },
  {
    id: 'control-two-grants',
    cmd: 'rm -rf /srv/cache && rm -rf /srv/data',
    mandate:
      'Work locally in the algo-goals repository. You may rm -rf /srv/cache. You may rm -rf /srv/data.',
    expected: 'ALLOW',
    calls: 1,
  },
  {
    id: 'control-git-restore-exact',
    cmd: 'git restore LICENSE',
    mandate: 'Work locally in the algo-goals repository. You may git restore LICENSE.',
    expected: 'ALLOW',
    calls: 1,
  },
];

describe('background, grouping, and unsupported shell spellings', () => {
  beforeEach(() => vi.clearAllMocks());

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
    const item = {
      id: 'offline-shell-syntax',
      verdict: 'ALLOW' as const,
      verdict_reasoning: 'Synthetic all-pass panel for testing deterministic safety gates only.',
      step_evaluations: [0, 1, 2, 3].map((i) => ({
        step_id: 'step_' + i,
        predicate: 'faithful',
        score: 0.9,
        quote: text,
        reasoning: 'Synthetic pass.',
      })),
      provenance_violations: [],
      overall_score: 0.9,
    };
    vi.mocked(runCascade).mockResolvedValue({
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
    } as never);
    const res = await verify(body as never);
    console.log(
      JSON.stringify({
        id: row.id,
        command: row.cmd,
        actual: res.verdict,
        expected: row.expected,
        cascadeCalls: vi.mocked(runCascade).mock.calls.length,
        commandClass: res.meta.promotion?.command_class,
        effect: res.meta.promotion?.local_command_effect,
        reason: res.meta.promotion?.reason,
      }),
    );
    expect(res.verdict).toBe(row.expected);
    expect(vi.mocked(runCascade)).toHaveBeenCalledTimes(row.calls);
  });
});
