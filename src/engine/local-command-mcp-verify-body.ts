/**
 * Faithful copy of thoughtproof-mcp `buildSentinelVerifyBody` at 07f6cd3f
 * (MCP #52), for offline review tests only.
 *
 * This copy does not model `quote` handling (`resolveMandateQuote` /
 * `buildSentinelEvidence`): a host quote is never selected, and the full
 * mandate is always the verbatim provenance span.
 */

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

export function buildSentinelVerifyBody(
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
