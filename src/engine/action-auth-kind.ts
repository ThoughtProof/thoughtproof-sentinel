/**
 * Conservative action-kind classifier for `action_authorization`.
 *
 * Gold steps were written for wallet drains (amount / 0x recipient /
 * unlimited approval). Crew FYI / status pings then fail for the wrong
 * reasons: issue numbers look like unbound spend, and named teammates
 * look like unauthorized counterparties (issue #33).
 *
 * This helper does NOT authorize anything. It never writes into caller
 * evidence. A `SENTINEL_AXIS_HINT` is attached only to the Sentinel-
 * authored verification *question*. Every caller `structural_fact:` is
 * neutralized before classify/annotate so a smuggled line cannot be
 * treated as authoritative (PR #34 review).
 *
 * It never asserts `objective_aligned=true`. An informational action
 * may reach public ALLOW only when the mandate is **positively**
 * `informational` (`mandate_kind === 'informational'`). Otherwise the
 * classifier asserts `objective_mismatch=true` and the engine
 * hard-BLOCKs (`objective_mismatch_fail_closed`) so cascade
 * `agreement_allow` cannot fail-open — including MCP
 * `claim === proposed_action`, unknown/ambiguous mandates, non-English
 * ship prose, and payment→notify. #37's English/DE ship + pay blacklist
 * remains mitigation lineage; this invert is the structural close
 * (issue #38). Companion MCP claim rewrite: thoughtproof-mcp#21 —
 * Sentinel does not paper over `claim === proposed_action`.
 *
 * Silent (no hint) on financial / permission / mixed-transfer *actions*
 * and on unknown actions against a positively informational mandate —
 * the existing amount/recipient/least-privilege criteria stay in charge.
 * An informational action vs an unknown mandate is not silent. An
 * `unknown` action vs a *named* non-informational mandate
 * (`deploy_ship` / `value_transfer` / `permission`) fail-closes as
 * BLOCK `objective_mismatch_fail_closed` (issue #47). Unknown/unknown
 * is UNCERTAIN `unclassified_abstention_fail_closed` — still no public
 * ALLOW, but the receipt says "classify better", not "action exceeds
 * mandate". A `deploy_ship` action (deploy / publish / pin) may
 * public-ALLOW only when the mandate is **positively** `deploy_ship`
 * (issue #49). Unknown or mismatched mandate fail-closes as BLOCK
 * `objective_mismatch_fail_closed` — same spirit as #38; the
 * high-blast kind without a financial net must not have more room
 * than an unknown action.
 *
 * Axis-selection keywords are English (`fyi`, `notify`, `tell`,
 * `inform`, `info`, `status ping`) plus a small DE informational set
 * (Informiere, Info an, Bescheid geben, Rückmeldung, Status an).
 * Target architecture: host-declared `mandate.kind` / `action.kind`
 * (companion thoughtproof-mcp#21); prose is fallback; `unknown` →
 * fail-closed. This file does not invent that host API.
 */

import type { AuthorizationMandate } from './authorization-gate.js';
import {
  MCP_EVIDENCE_ACTION_LABEL,
  MCP_EVIDENCE_MANDATE_LABEL,
  MCP_EVIDENCE_REASONING_LABEL,
  MCP_EVIDENCE_USER_MANDATE_LABEL,
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
  /** Both kinds unknown — abstention, not a named mandate conflict. */
  unclassified_abstention: boolean;
  identifiers_are_not_spend_amounts: boolean;
  /**
   * Sentinel-authored axis hint for the verification question.
   * Null when we have nothing confident to tell the cascade.
   * Never a `structural_fact:` evidence line.
   */
  axisHint: string | null;
}

export const CALLER_STRUCTURAL_FACT_REDACTION =
  '[caller-supplied structural_fact removed]';

export const SENTINEL_AXIS_HINT_LABEL =
  'SENTINEL_AXIS_HINT (system-origin, not evidence):';

/** Whole-line / rest-of-line payload — do not leave `action_kind=…` behind. */
const CALLER_STRUCTURAL_FACT_RE = /structural_fact\s*:[^\n]*/gi;

const VALUE_RE =
  /\$\s*\d|\d[\d,.]*\s*(?:USDC|USD|ETH|EUR|WETH)\b|transfer\s+\d|swap\s+\d|bridge\s+\d|pay(?:ing)?\s+(?:invoice\s+)?\d|invoice\s*#?\s*\d|\bnotional\b|\bbudget\b|\bceiling\b/i;

const PERMISSION_RE =
  /MAX_UINT256|unlimited\s+approval|approve\s*\(|Permit2|blanket\s+permit|\ballowance\b|spend\s+authority/i;

const DE_SHIP_VERBS = 'deploye|veröffentliche|veröffentlichen|ausliefern';

/**
 * Positive ship/pin/deploy/publish for Ship-mismatch. Omits bare `release`
 * (FYI "release notes" must not flip a notify mandate). Negated mentions
 * ("no deploy", "kein Deploy", "do not pin npm") do not count. Small DE
 * verb set only — not full i18n.
 */
const POSITIVE_SHIP_RE =
  new RegExp(
    `\\b(?:ship(?:ping)?|deploy(?:ing)?|publish(?:ing)?|pin(?:ning)?(?:\\s+the)?\\s+npm|npm\\s+(?:version\\s+)?pin|send-to-prod|${DE_SHIP_VERBS})\\b`,
    'gi',
  );

const SHIP_NEGATION_BEFORE_RE =
  /(?:\bno\b|\bnot\b|\bnever\b|\bwithout\b|\bdon'?t\b|\bdo\s+not\b|\bkein(?:e|en|em|er)?\b|\bnicht\b|\bohne\b|\bniemals\b)\s+(?:\w+\s+){0,4}$/i;

/** English informational heads (no language-specific particles). */
const EN_INFO_HEAD =
  '(?:fyi|notify|notifying|tell|telling|inform|info|status(?:\\s+ping)?)';

/**
 * Small DE informational set (issue #47) — not full i18n.
 * Informiere / Info an / Bescheid / Rückmeldung. "Status an" is covered
 * by the English `status` head (`status(?:\\s+ping)?` matches "Status an").
 */
const DE_INFO_HEAD = '(?:informier(?:e|en|t)|bescheid|r[uü]ckmeldung)';

const INFO_HEAD_RE = new RegExp(
  `^(?:the\\s+proposed\\s+)?(?:${EN_INFO_HEAD}|${DE_INFO_HEAD})\\b`,
  'i',
);

const EN_INFO_ANY =
  '(?:fyi|status[- ]ping|notify(?:ing)?|tell(?:ing)?\\s+\\w+|inform|info)';

const DE_INFO_ANY =
  '(?:informier(?:e|en|t)|info\\s+an|status\\s+an|r[uü]ckmeldung|bescheid(?:\\s+(?:geben|sagen))?|gib(?:st|t)?\\s+(?:\\w+\\s+){0,4}bescheid)';

const INFO_ANY_RE = new RegExp(`\\b(?:${EN_INFO_ANY}|${DE_INFO_ANY})\\b`, 'i');

const VALUE_HEAD_RE =
  /^(?:granting|grant|approve|approving|sign(?:ing)?|permit|transfer|send(?:ing)?\s+\d|swap(?:ping)?|bridge|pay(?:ing)?)\b/i;

const DEPLOY_HEAD_RE =
  /^(?:ship(?:ping)?|deploy(?:ing)?|publish(?:ing)?|pin(?:ning)?|release|deploye|veröffentliche|veröffentlichen|ausliefern)\b/i;

const ETH_ADDR_RE = /0x[0-9a-fA-F]{40}/;

const TRANSFER_VERB_RE =
  /\b(?:send(?:ing)?|transfer(?:ring)?|pay(?:ing)?|wire(?:ing)?|swap(?:ping)?|bridge(?:ing)?)\b/i;

const MONEY_CONTEXT_RE =
  /\$|USDC|USD|ETH|EUR|WETH|budget|ceiling|allowance|MAX_UINT|notional|invoice/i;

const NOTIFY_OBJECT_RE =
  /\b(?:notify(?:ing)?|tell(?:ing)?|inform(?:iere|ieren|iert)?|fyi(?:\s+to)?|info|status|r[uü]ckmeldung|bescheid)\s+(?:an?\s+|an\s+)?([^\n,.;:]+?)(?=\s+(?:that|about|host|issue|status|we|the\s+|to\s+|for\b|über|zum|zur|dass)\b|\s*[.,;:]|$)/gi;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Neutralize every caller `structural_fact:` (prefix + rest of line). */
export function sanitizeCallerStructuralFacts(text: string): string {
  if (!text) return text ?? '';
  return text.replace(CALLER_STRUCTURAL_FACT_RE, CALLER_STRUCTURAL_FACT_REDACTION);
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
    // thoughtproof-mcp puts the full instruction under `User mandate:` when
    // the host quote is a proper excerpt. Classification must use the full
    // instruction, not only the provenance span.
    const userMandate = sectionAfter(evidence, MCP_EVIDENCE_USER_MANDATE_LABEL, [
      MCP_EVIDENCE_MANDATE_LABEL,
      MCP_EVIDENCE_ACTION_LABEL,
    ]);
    return {
      mandate: userMandate ? userMandate : mcpMandate,
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

function notifyObjects(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(NOTIFY_OBJECT_RE.source, 'gi'))) {
    const raw = (m[1] ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (raw.length >= 2 && raw.length <= 60) out.push(raw);
  }
  return [...new Set(out)];
}

/** Recipient = notify-object intersection of mandate and action (no crew roster). */
function namedRecipientInMandate(mandate: string, action: string): boolean {
  const actionObjs = notifyObjects(action);
  if (actionObjs.length === 0) return false;
  const mandateLc = mandate.toLowerCase();
  const mandateObjs = notifyObjects(mandate);
  return actionObjs.some((obj) => mandateObjs.includes(obj) || mandateLc.includes(obj));
}

function hasValueTransfer(text: string): boolean {
  return VALUE_RE.test(text);
}

function hasPermissionGrant(text: string): boolean {
  return PERMISSION_RE.test(text);
}

function hasEthAddress(text: string): boolean {
  return ETH_ADDR_RE.test(text);
}

function hasTransferVerbWithNumber(text: string): boolean {
  return TRANSFER_VERB_RE.test(text) && /\d/.test(text);
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
  // Positive ship only — "kein Deploy" / "no deploy" must not win over FYI.
  if (hasPositiveShipInstruction(text) && !INFO_ANY_RE.test(text)) return 'deploy_ship';
  if (INFO_ANY_RE.test(text) && !hasValueTransfer(text) && !hasPermissionGrant(text)) {
    return 'informational';
  }
  if (hasPositiveShipInstruction(text)) return 'deploy_ship';
  return 'unknown';
}

/** Bare issue numbers / versions are identifiers when no money language is present. */
function identifiersAreNotSpendAmounts(corpus: string): boolean {
  return !MONEY_CONTEXT_RE.test(corpus);
}

/**
 * True when the text contains a positive ship/pin/deploy/publish instruction.
 * Negated mentions do not count. Bare "release" is ignored.
 */
export function hasPositiveShipInstruction(text: string): boolean {
  if (!text) return false;
  const re = new RegExp(POSITIVE_SHIP_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 48), m.index);
    if (SHIP_NEGATION_BEFORE_RE.test(before)) continue;
    return true;
  }
  return false;
}

export const OBJECTIVE_MISMATCH_BLOCK_REASON =
  'Deterministic objective mismatch: public ALLOW requires positively derived kind fit. Informational/notify or unknown actions may ALLOW only when mandate_kind is informational; deploy/publish/pin actions may ALLOW only when mandate_kind is deploy_ship. Unknown or mismatched mandate, or notify/FYI against a named ship/pay/permission mandate, is objective_mismatch.';

export const UNCLASSIFIED_ABSTENTION_REASON =
  'Unclassified abstention: action_kind and mandate_kind are both unknown. No public ALLOW (fail-closed). Not a named objective mismatch — classify better (host-declared kind or prose markers).';

/** Trust is positively derived: only this kind may ALLOW an informational action. */
export function mandateIsPositivelyInformational(kind: ActionKind): boolean {
  return kind === 'informational';
}

/** Trust is positively derived: only this kind may ALLOW a deploy/publish/pin action. */
export function mandateIsPositivelyDeployShip(kind: ActionKind): boolean {
  return kind === 'deploy_ship';
}

/** Named non-informational mandates — a real conflict vs unknown/notify action. */
export function mandateIsNamedNonInformational(kind: ActionKind): boolean {
  return kind === 'deploy_ship' || kind === 'value_transfer' || kind === 'permission';
}

export function isUnclassifiedAbstention(
  actionKind: ActionKind,
  mandateKind: ActionKind,
): boolean {
  return actionKind === 'unknown' && mandateKind === 'unknown';
}

/**
 * Public-ALLOW allowlist (issues #38 / #47 / #49).
 * Returns false whenever public ALLOW is forbidden by kind pairing.
 *
 * - informational or unknown action → only when mandate is positively
 *   informational (#38 / #47)
 * - deploy_ship action → only when mandate is positively deploy_ship
 *   (#49; high-blast, no financial net)
 * - unknown/unknown is still not-allow (promotion maps it to UNCERTAIN
 *   `unclassified_abstention_fail_closed`, not BLOCK)
 * - value_transfer / permission stay out of this rule (financial gate)
 *
 * Fail-closed reason for a blocked deploy/informational pair is
 * `objective_mismatch_fail_closed` (same promotion mapping as #38).
 */
export function informationalActionMayPublicAllow(
  actionKind: ActionKind,
  mandateKind: ActionKind,
): boolean {
  if (actionKind === 'informational' || actionKind === 'unknown') {
    return mandateIsPositivelyInformational(mandateKind);
  }
  if (actionKind === 'deploy_ship') {
    return mandateIsPositivelyDeployShip(mandateKind);
  }
  return true;
}

export interface ActionAuthUnknownKindCounts {
  unknown_action: number;
  unknown_mandate: number;
}

const unknownKindCounts: ActionAuthUnknownKindCounts = {
  unknown_action: 0,
  unknown_mandate: 0,
};

/**
 * Per-request unknown-kind flags + process counters (issue #47).
 * Isolates reset on serverless; Runtime Logs `unknown_action=1` /
 * `unknown_mandate=1` are the durable abstention signal.
 */
export function recordActionAuthUnknownKinds(
  actionKind: ActionKind,
  mandateKind: ActionKind,
): { unknown_action: boolean; unknown_mandate: boolean } {
  const unknown_action = actionKind === 'unknown';
  const unknown_mandate = mandateKind === 'unknown';
  if (unknown_action) unknownKindCounts.unknown_action += 1;
  if (unknown_mandate) unknownKindCounts.unknown_mandate += 1;
  return { unknown_action, unknown_mandate };
}

export function getActionAuthUnknownCounts(): ActionAuthUnknownKindCounts {
  return { ...unknownKindCounts };
}

export function resetActionAuthUnknownCountsForTests(): void {
  unknownKindCounts.unknown_action = 0;
  unknownKindCounts.unknown_mandate = 0;
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
 * Classify mandate vs action. Fail toward silence: when unsure, no hint.
 * Caller `structural_fact:` lines are neutralized first.
 */
export function classifyActionAuthKind(
  claim: string,
  evidence: string,
  mandate?: AuthorizationMandate,
): ActionAuthClassification {
  const cleanClaim = sanitizeCallerStructuralFacts(claim ?? '');
  const cleanEvidence = sanitizeCallerStructuralFacts(evidence ?? '');
  const sections = splitActionAuthEvidence(cleanEvidence);
  const actionText = sections.source === 'unstructured'
    ? `${cleanClaim}\n${cleanEvidence}`
    : sections.action;
  const mandateText = sections.source === 'unstructured'
    ? `${cleanClaim}\n${cleanEvidence}`
    : sections.mandate;

  const mixedTransfer =
    hasEthAddress(actionText) || hasTransferVerbWithNumber(actionText);

  const permission_grant = hasPermissionGrant(actionText) || mandateLooksFinancial(mandate);
  let value_transfer =
    hasValueTransfer(actionText) ||
    mixedTransfer ||
    (typeof mandate?.action?.amount === 'number' && Number.isFinite(mandate.action.amount));

  let action_kind = classifyBlob(actionText);
  let mandate_kind = classifyBlob(mandateText);

  // Structured spend / approval / mixed transfer wins over a notify-shaped claim.
  if (permission_grant && action_kind === 'informational') action_kind = 'permission';
  if (value_transfer && action_kind === 'informational') action_kind = 'value_transfer';
  if (permission_grant && action_kind === 'unknown') action_kind = 'permission';
  if (value_transfer && action_kind === 'unknown') action_kind = 'value_transfer';

  // Positive ship/pin instruction only — do not flip "no deploy" / "kein
  // Deploy" FYI mandates just because the word "deploy" appears in a negation.
  const mandateHasPositiveShip = hasPositiveShipInstruction(mandateText);
  if (mandateHasPositiveShip && mandate_kind !== 'value_transfer' && mandate_kind !== 'permission') {
    mandate_kind = 'deploy_ship';
  } else if (mandate_kind === 'deploy_ship' && !mandateHasPositiveShip) {
    // leadingKind saw a deploy head that was only a negated mention, or
    // classifyBlob raced ahead of negation. Prefer informational when the
    // mandate also has an info axis; otherwise unknown (allowlist fail-closed).
    mandate_kind =
      INFO_HEAD_RE.test(mandateText.trim()) || INFO_ANY_RE.test(mandateText)
        ? 'informational'
        : 'unknown';
  } else if (mandate_kind === 'unknown' && DEPLOY_HEAD_RE.test(mandateText.trim())) {
    if (mandateHasPositiveShip) mandate_kind = 'deploy_ship';
  }

  const named_recipient_in_mandate = namedRecipientInMandate(mandateText, actionText);

  // Informational/notify action: public ALLOW only when the mandate is
  // positively informational. Ship/pay/permission fail closed as a
  // named conflict. Unknown/unknown is abstention (UNCERTAIN), not
  // objective_mismatch. Independent of leadingKind on the mandate so
  // "After CI, ship. Also notify CoS" still mismatches. A deploy/publish
  // /pin *action* may ALLOW only when the mandate is positively
  // deploy_ship (#49) — unknown or mismatched mandate is a named
  // conflict, not cascade room. Spend/permission actions stay with
  // the financial gate.
  const actionIsNotifyOnly =
    action_kind === 'informational' &&
    !hasValueTransfer(actionText) &&
    !hasPermissionGrant(actionText) &&
    !mixedTransfer;

  const unclassified_abstention = isUnclassifiedAbstention(action_kind, mandate_kind);
  const unknownActionVsNamedMandate =
    action_kind === 'unknown' && mandateIsNamedNonInformational(mandate_kind);
  const deployVsNonMatchingMandate =
    action_kind === 'deploy_ship' && !mandateIsPositivelyDeployShip(mandate_kind);

  const objective_mismatch =
    (actionIsNotifyOnly && !mandateIsPositivelyInformational(mandate_kind)) ||
    unknownActionVsNamedMandate ||
    deployVsNonMatchingMandate;

  const identifiers_are_not_spend_amounts =
    !value_transfer &&
    !permission_grant &&
    identifiersAreNotSpendAmounts(`${cleanClaim}\n${mandateText}\n${actionText}`);

  const silent =
    mixedTransfer ||
    action_kind === 'value_transfer' ||
    action_kind === 'permission' ||
    (action_kind === 'unknown' && !unknownActionVsNamedMandate && !unclassified_abstention);

  let axisHint: string | null = null;
  if (
    !silent &&
    (action_kind === 'informational' ||
      unknownActionVsNamedMandate ||
      unclassified_abstention ||
      deployVsNonMatchingMandate)
  ) {
    const parts = [
      `action_kind=${action_kind}`,
      'value_transfer=false',
      'permission_grant=false',
    ];
    if (identifiers_are_not_spend_amounts) {
      parts.push('identifiers_are_not_spend_amounts=true');
    }
    if (named_recipient_in_mandate) {
      parts.push('named_recipient_in_mandate=true');
    }
    parts.push(`mandate_kind=${mandate_kind}`);
    if (objective_mismatch) {
      parts.push('objective_mismatch=true');
    }
    if (unclassified_abstention) {
      parts.push('unclassified_abstention=true');
    }
    axisHint = `${SENTINEL_AXIS_HINT_LABEL} ${parts.join('; ')}`;
  }

  return {
    action_kind,
    mandate_kind,
    value_transfer,
    permission_grant,
    named_recipient_in_mandate,
    objective_mismatch,
    unclassified_abstention,
    identifiers_are_not_spend_amounts,
    axisHint,
  };
}

export interface PreparedActionAuthEval {
  sanitizedEvidence: string;
  classification: ActionAuthClassification;
  axisHint: string | null;
}

/**
 * Sanitize caller evidence and classify. Never prepends a fact to evidence.
 */
export function prepareActionAuthEval(
  claim: string,
  evidence: string,
  mandate?: AuthorizationMandate,
): PreparedActionAuthEval {
  const sanitizedEvidence = sanitizeCallerStructuralFacts(evidence ?? '');
  const classification = classifyActionAuthKind(claim, sanitizedEvidence, mandate);
  return {
    sanitizedEvidence,
    classification,
    axisHint: classification.axisHint,
  };
}

/**
 * Evidence passed to the cascade: caller `structural_fact:` neutralized.
 * Does NOT inject a system fact (that belongs on the question only).
 */
export function annotateEvidenceWithActionAuthKind(
  _claim: string,
  evidence: string,
  _mandate?: AuthorizationMandate,
): string {
  return sanitizeCallerStructuralFacts(evidence ?? '');
}
