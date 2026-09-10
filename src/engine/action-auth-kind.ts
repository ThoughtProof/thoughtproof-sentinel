/**
 * Conservative action-kind classifier for `action_authorization`.
 *
 * Gold steps were written for wallet drains (amount / 0x recipient /
 * unlimited approval). Crew FYI / status pings then fail for the wrong
 * reasons: issue numbers look like unbound spend, and named teammates
 * look like unauthorized counterparties (issue #33).
 *
 * This helper does NOT authorize anything. It only emits a
 * `structural_fact:` line the gold steps may treat as authoritative for
 * *axis selection* (informational vs value-transfer). It never asserts
 * `objective_aligned=true`. It MAY assert `objective_mismatch=true`
 * when the mandate is ship/pin/deploy and the action is notify-only
 * (strengthens Ship-mismatch fail-closed).
 *
 * Silent (no fact) on financial / permission / unknown actions — the
 * existing amount/recipient/least-privilege criteria stay in charge.
 */

import type { AuthorizationMandate } from './authorization-gate.js';
import {
  MCP_EVIDENCE_ACTION_LABEL,
  MCP_EVIDENCE_MANDATE_LABEL,
  MCP_EVIDENCE_REASONING_LABEL,
} from '../step-quote-provenance.js';

export type ActionKind =
  | 'informational'
  | 'value_transfer'
  | 'permission'
  | 'deploy_ship'
  | 'unknown';

export interface ActionAuthSections {
  mandate: string;
  action: string;
  reasoning: string;
  source: 'mcp' | 'suite' | 'unstructured';
}

export interface ActionAuthClassification {
  action_kind: ActionKind;
  mandate_kind: ActionKind;
  value_transfer: boolean;
  permission_grant: boolean;
  named_recipient_in_mandate: boolean;
  objective_mismatch: boolean;
  identifiers_are_not_spend_amounts: boolean;
  /** Null when we have nothing confident to tell the cascade. */
  structural_fact: string | null;
}

const STRUCTURAL_FACT_PREFIX = 'structural_fact:';

const VALUE_RE =
  /\$\s*\d|\d[\d,.]*\s*(?:USDC|USD|ETH|EUR|WETH)\b|transfer\s+\d|swap\s+\d|bridge\s+\d|pay(?:ing)?\s+(?:invoice\s+)?\d|invoice\s*#?\s*\d|\bnotional\b|\bbudget\b|\bceiling\b/i;

const PERMISSION_RE =
  /MAX_UINT256|unlimited\s+approval|approve\s*\(|Permit2|blanket\s+permit|\ballowance\b|spend\s+authority/i;

const DEPLOY_RE =
  /\b(?:ship(?:ping)?|deploy(?:ing)?|publish(?:ing)?|pin(?:ning)?(?:\s+the)?\s+npm|npm\s+(?:version\s+)?pin|send-to-prod|release)\b/i;

const INFO_HEAD_RE =
  /^(?:the\s+proposed\s+)?(?:fyi|notify|notifying|tell|telling|inform|info(?:rm)?(?:\s+an)?|status(?:\s+ping)?)\b/i;

const INFO_ANY_RE =
  /\b(?:fyi|status[- ]ping|notify(?:ing)?|tell(?:ing)?\s+\w+|info(?:rm)?(?:\s+an)?)\b/i;

const VALUE_HEAD_RE =
  /^(?:granting|grant|approve|approving|sign(?:ing)?|permit|transfer|send(?:ing)?\s+\d|swap(?:ping)?|bridge|pay(?:ing)?)\b/i;

const DEPLOY_HEAD_RE =
  /^(?:ship(?:ping)?|deploy(?:ing)?|publish(?:ing)?|pin(?:ning)?|release)\b/i;

const CREW: ReadonlyArray<{ id: string; aliases: readonly string[] }> = [
  { id: 'cos', aliases: ['chief of staff', 'cos'] },
  { id: 'qa', aliases: ['qa', 'quality assurance'] },
];

const MONEY_CONTEXT_RE =
  /\$|USDC|USD|ETH|EUR|WETH|budget|ceiling|allowance|MAX_UINT|notional|invoice/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionAfter(
  evidence: string,
  label: string,
  nextLabels: string[],
): string | null {
  const labelRe = new RegExp(escapeRe(label), 'i');
  const m = evidence.match(labelRe);
  if (!m || m.index === undefined) return null;
  const after = evidence.slice(m.index + m[0].length);
  const next = nextLabels.map(escapeRe).join('|');
  const cut = after.search(new RegExp(`\\n(?:${next})`, 'i'));
  const raw = (cut === -1 ? after : after.slice(0, cut)).trim();
  return raw || '';
}

export function splitActionAuthEvidence(evidence: string): ActionAuthSections {
  const mcpMandate = sectionAfter(evidence, MCP_EVIDENCE_MANDATE_LABEL, [
    MCP_EVIDENCE_ACTION_LABEL,
    MCP_EVIDENCE_REASONING_LABEL,
  ]);
  const mcpAction = sectionAfter(evidence, MCP_EVIDENCE_ACTION_LABEL, [
    MCP_EVIDENCE_REASONING_LABEL,
    'Context:',
  ]);
  if (mcpMandate !== null && mcpAction !== null) {
    return {
      mandate: mcpMandate,
      action: mcpAction,
      reasoning:
        sectionAfter(evidence, MCP_EVIDENCE_REASONING_LABEL, ['Context:']) ?? '',
      source: 'mcp',
    };
  }

  const suiteMandate = sectionAfter(evidence, 'USER INSTRUCTION:', [
    'AGENT PROPOSED ACTION:',
    'AGENT REASONING:',
    'WALLET BALANCE:',
  ]);
  const suiteAction = sectionAfter(evidence, 'AGENT PROPOSED ACTION:', [
    'AGENT REASONING:',
  ]);
  if (suiteMandate !== null && suiteAction !== null) {
    return {
      mandate: suiteMandate,
      action: suiteAction,
      reasoning: sectionAfter(evidence, 'AGENT REASONING:', []) ?? '',
      source: 'suite',
    };
  }

  return { mandate: evidence, action: evidence, reasoning: '', source: 'unstructured' };
}

function crewIds(text: string): Set<string> {
  const s = text.toLowerCase();
  const ids = new Set<string>();
  for (const c of CREW) {
    for (const alias of c.aliases) {
      const re = new RegExp(`\\b${alias.replace(/\s+/g, '\\s+')}\\b`, 'i');
      if (re.test(s)) ids.add(c.id);
    }
  }
  return ids;
}

function hasValueTransfer(text: string): boolean {
  return VALUE_RE.test(text);
}

function hasPermissionGrant(text: string): boolean {
  return PERMISSION_RE.test(text);
}

function leadingKind(text: string): ActionKind {
  const head = text.trim();
  if (!head) return 'unknown';
  if (VALUE_HEAD_RE.test(head)) {
    return /approve|grant|permit|sign/i.test(head.slice(0, 40))
      ? 'permission'
      : 'value_transfer';
  }
  if (DEPLOY_HEAD_RE.test(head)) return 'deploy_ship';
  if (INFO_HEAD_RE.test(head)) return 'informational';
  return 'unknown';
}

function classifyBlob(text: string): ActionKind {
  const lead = leadingKind(text);
  if (lead !== 'unknown') return lead;
  if (hasPermissionGrant(text)) return 'permission';
  if (hasValueTransfer(text)) return 'value_transfer';
  if (DEPLOY_RE.test(text) && !INFO_ANY_RE.test(text)) return 'deploy_ship';
  if (INFO_ANY_RE.test(text) && !hasValueTransfer(text) && !hasPermissionGrant(text)) {
    return 'informational';
  }
  if (DEPLOY_RE.test(text)) return 'deploy_ship';
  return 'unknown';
}

/** Bare issue numbers / versions are identifiers when no money language is present. */
function identifiersAreNotSpendAmounts(corpus: string): boolean {
  return !MONEY_CONTEXT_RE.test(corpus);
}

function mandateLooksFinancial(mandate?: AuthorizationMandate): boolean {
  if (!mandate) return false;
  const amount = mandate.action?.amount;
  const max = mandate.granted?.maxAmount;
  const allowance = mandate.action?.allowance;
  if (typeof amount === 'number' && Number.isFinite(amount)) return true;
  if (typeof max === 'number' && Number.isFinite(max)) return true;
  if (allowance !== undefined && allowance !== null && String(allowance).trim() !== '') {
    return true;
  }
  return false;
}

/**
 * Classify mandate vs action. Fail toward silence: when unsure, no fact.
 */
export function classifyActionAuthKind(
  claim: string,
  evidence: string,
  mandate?: AuthorizationMandate,
): ActionAuthClassification {
  const sections = splitActionAuthEvidence(evidence);
  const actionText = sections.source === 'unstructured'
    ? `${claim}\n${evidence}`
    : sections.action;
  const mandateText = sections.source === 'unstructured'
    ? `${claim}\n${evidence}`
    : sections.mandate;

  const permission_grant = hasPermissionGrant(actionText) || mandateLooksFinancial(mandate);
  const value_transfer =
    hasValueTransfer(actionText) ||
    (typeof mandate?.action?.amount === 'number' && Number.isFinite(mandate.action.amount));

  let action_kind = classifyBlob(actionText);
  let mandate_kind = classifyBlob(mandateText);

  // Structured spend / approval wins over a notify-shaped claim.
  if (permission_grant && action_kind === 'informational') action_kind = 'permission';
  if (value_transfer && action_kind === 'informational') action_kind = 'value_transfer';
  if (permission_grant && action_kind === 'unknown') action_kind = 'permission';
  if (value_transfer && action_kind === 'unknown') action_kind = 'value_transfer';

  // Positive ship/pin instruction only — do not flip "no deploy" FYI
  // mandates just because the word "deploy" appears in a negation.
  if (mandate_kind === 'unknown' && DEPLOY_HEAD_RE.test(mandateText.trim())) {
    mandate_kind = 'deploy_ship';
  }

  const named_recipient_in_mandate = [...crewIds(actionText)].some((id) =>
    crewIds(mandateText).has(id),
  );

  const objective_mismatch =
    mandate_kind === 'deploy_ship' &&
    action_kind === 'informational' &&
    !hasValueTransfer(actionText) &&
    !hasPermissionGrant(actionText);

  const identifiers_are_not_spend_amounts =
    !value_transfer &&
    !permission_grant &&
    identifiersAreNotSpendAmounts(`${claim}\n${mandateText}\n${actionText}`);

  const silentFinancial =
    action_kind === 'value_transfer' ||
    action_kind === 'permission' ||
    action_kind === 'unknown';

  let structural_fact: string | null = null;
  if (!silentFinancial && action_kind === 'informational') {
    const parts = [
      'action_kind=informational',
      'value_transfer=false',
      'permission_grant=false',
    ];
    if (identifiers_are_not_spend_amounts) {
      parts.push('identifiers_are_not_spend_amounts=true');
    }
    if (named_recipient_in_mandate) {
      parts.push('named_recipient_in_mandate=true');
    }
    if (objective_mismatch) {
      parts.push('mandate_kind=deploy_ship', 'objective_mismatch=true');
    }
    structural_fact = `${STRUCTURAL_FACT_PREFIX} ${parts.join('; ')}`;
  }

  return {
    action_kind,
    mandate_kind,
    value_transfer,
    permission_grant,
    named_recipient_in_mandate,
    objective_mismatch,
    identifiers_are_not_spend_amounts,
    structural_fact,
  };
}

/** Prepend a structural_fact line when classification is confident. */
export function annotateEvidenceWithActionAuthKind(
  claim: string,
  evidence: string,
  mandate?: AuthorizationMandate,
): string {
  const c = classifyActionAuthKind(claim, evidence, mandate);
  if (!c.structural_fact) return evidence;
  if (evidence.startsWith(STRUCTURAL_FACT_PREFIX)) return evidence;
  return `${c.structural_fact}\n\n${evidence}`;
}
