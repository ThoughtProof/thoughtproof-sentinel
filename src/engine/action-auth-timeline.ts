/**
 * Order-neutral timeline for action_authorization (F2).
 *
 * pot-cli 0.8.13 grades faithfulness F2 by the order of reasoning and action
 * blocks in the transcript. Sentinel passes caller evidence through in the
 * caller's section order, so that order is display order, not execution time.
 * A lab swap of those two blocks, with the same words and the same execution
 * time, flipped BLOCK to ALLOW.
 *
 * This module is inert unless `SENTINEL_AA_TIMELINE_CANONICAL` is exactly
 * `1` or `true`. It does not change other modes, pot-cli, or
 * `conditional_allow_no_machine_proof`.
 *
 * When the flag is on:
 *  1. Known suite and thoughtproof-mcp labelled formats are re-emitted in one
 *     order. Section text stays verbatim (trimmed). A repeated label or an
 *     unrecognised format is left unchanged. Classification uses the
 *     neutralized original, not the reordered text.
 *  2. An execution marker and per-evidence post-hoc are separate. Post hoc
 *     means an evidence item with its own creation timestamp after execution,
 *     or an item in a POST-EXECUTION EVIDENCE section. The marker alone is not
 *     post hoc.
 *  3. A system timeline hint is appended to the question. Without an
 *     execution marker it states only that section order is not chronology
 *     and that the execution time is unknown.
 *  4. Caller lines that forge `SENTINEL_TIMELINE_HINT` are redacted.
 *     `SENTINEL_AXIS_HINT` is not redacted (existing gap, out of scope).
 *  5. The floor in the engine is downgrade-only: public ALLOW becomes
 *     UNCERTAIN when post-hoc evidence is present. It never upgrades.
 */

export const SENTINEL_AA_TIMELINE_CANONICAL_ENV = 'SENTINEL_AA_TIMELINE_CANONICAL';

/** Default off. Only the exact strings `1` and `true` enable the flag. */
export function actionAuthTimelineCanonicalEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[SENTINEL_AA_TIMELINE_CANONICAL_ENV];
  return raw === '1' || raw === 'true';
}

export const SENTINEL_TIMELINE_HINT_LABEL =
  'SENTINEL_TIMELINE_HINT (system-origin, not evidence):';

/**
 * Replacement for a caller line that contains the system hint keyword.
 * The placeholder must not contain that keyword. A prefix such as
 * "[caller-supplied SENTINEL_TIMELINE_HINT …" can be supplied by the request;
 * protecting that prefix would let the forged hint through.
 */
export const CALLER_TIMELINE_HINT_REDACTION = '[caller-supplied timeline hint removed]';

const TIMELINE_HINT_KEYWORD = 'sentinel_timeline_hint';

type Role =
  | 'preamble'
  | 'user_mandate'
  | 'mandate'
  | 'wallet'
  | 'reasoning'
  | 'action'
  | 'post_execution'
  | 'context';

const SUITE_LABELS: Array<[string, Role]> = [
  ['USER INSTRUCTION:', 'mandate'],
  ['WALLET BALANCE:', 'wallet'],
  ['AGENT PROPOSED ACTION:', 'action'],
  ['AGENT REASONING:', 'reasoning'],
  ['POST-EXECUTION EVIDENCE:', 'post_execution'],
];

const MCP_LABELS: Array<[string, Role]> = [
  ['User mandate:', 'user_mandate'],
  ['Principal mandate (verbatim quote):', 'mandate'],
  ['Proposed action:', 'action'],
  ['Agent reasoning:', 'reasoning'],
  ['Post-execution evidence:', 'post_execution'],
  ['Context:', 'context'],
];

const CANONICAL: Role[] = [
  'preamble',
  'user_mandate',
  'mandate',
  'wallet',
  'reasoning',
  'action',
  'post_execution',
  'context',
];

export interface CanonicalResult {
  text: string;
  format: 'suite' | 'mcp' | 'unchanged';
  reordered: boolean;
  reason?: string;
}

function countOcc(hay: string, needle: string): number {
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

export function canonicalizeActionAuthEvidence(evidence: string): CanonicalResult {
  const ev = evidence ?? '';
  for (const [format, labels] of [
    ['suite', SUITE_LABELS],
    ['mcp', MCP_LABELS],
  ] as const) {
    const hits = labels
      .map(([label, role]) => ({ label, role, n: countOcc(ev, label), at: ev.indexOf(label) }))
      .filter((h) => h.n > 0);
    const roles = new Set(hits.map((h) => h.role));
    if (!((roles.has('mandate') || roles.has('user_mandate')) && roles.has('action') && roles.has('reasoning'))) {
      continue;
    }
    if (hits.some((h) => h.n > 1)) {
      return { text: ev, format: 'unchanged', reordered: false, reason: `ambiguous_${format}_label_repeated` };
    }
    hits.sort((a, b) => a.at - b.at);
    const sections: Array<{ role: Role; text: string }> = [];
    if (hits[0].at > 0 && ev.slice(0, hits[0].at).trim()) {
      sections.push({ role: 'preamble', text: ev.slice(0, hits[0].at).trim() });
    }
    hits.forEach((h, i) =>
      sections.push({
        role: h.role,
        text: ev.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : ev.length).trim(),
      }),
    );
    const ordered = [...sections].sort(
      (a, b) => CANONICAL.indexOf(a.role) - CANONICAL.indexOf(b.role),
    );
    const sep = format === 'mcp' ? '\n\n' : '\n';
    const text = ordered.map((s) => s.text).join(sep);
    return { text, format, reordered: ordered.some((s, i) => s !== sections[i]) };
  }
  return { text: ev, format: 'unchanged', reordered: false, reason: 'no_recognised_format' };
}

export type TimelineHintVariant = 'no_marker' | 'execution_marker_only' | 'post_execution_evidence';

export interface ActionAuthTimelineDetection {
  /**
   * True only when a specific evidence item is later than execution (its own
   * creation timestamp is greater) or it sits in a POST-EXECUTION EVIDENCE
   * section. An execution marker alone never sets this.
   */
  post_execution: boolean;
  basis: string[];
  /** Whether the evidence states that the action was executed, and when. */
  execution_marker: boolean;
  executed_at: string | null;
  hint_variant: TimelineHintVariant;
  /** The request labels the action as proposed. Stated as given, not as time. */
  action_labelled_proposed: boolean;
}

export interface ActionAuthTimelineModelMeta extends ActionAuthTimelineDetection {
  canonical_format: 'suite' | 'mcp' | 'unchanged';
  reordered: boolean;
  canonical_reason?: string;
}

export interface ActionAuthTimelineReceiptMeta extends ActionAuthTimelineModelMeta {
  floor_applied: boolean;
  /** Public verdict from the promotion layer before this floor. */
  pre_floor_public_verdict: 'ALLOW' | 'BLOCK' | 'UNCERTAIN';
}

const ISO = String.raw`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))`;
const EXECUTED_RE = new RegExp(String.raw`\b(?:ACTION EXECUTED AT|executed_at)\s*:\s*` + ISO, 'gi');
const CREATED_RE = new RegExp(
  String.raw`\b(EVIDENCE CREATED AT|REASONING CREATED AT|evidence_created_at|reasoning_created_at)\s*:\s*` + ISO,
  'gi',
);
const POST_SECTION_LABELS = ['POST-EXECUTION EVIDENCE:', 'Post-execution evidence:'] as const;
const SECTION_LABELS = [
  'USER INSTRUCTION:',
  'WALLET BALANCE:',
  'AGENT PROPOSED ACTION:',
  'AGENT REASONING:',
  'POST-EXECUTION EVIDENCE:',
  'User mandate:',
  'Principal mandate (verbatim quote):',
  'Proposed action:',
  'Agent reasoning:',
  'Post-execution evidence:',
  'Context:',
] as const;
const PROPOSED_LABEL_RE = /(AGENT PROPOSED ACTION:|Proposed action:)/;

/** Milliseconds from Date.parse plus any fractional digits beyond milliseconds. */
interface TimelineInstant {
  ms: number;
  /** Fractional digits after the first three. Trailing zeros removed. */
  subMs: string;
}

/**
 * Compare the timestamp text at the precision it states. Date.parse stops at
 * milliseconds, so a creation time strictly later in the same millisecond
 * would otherwise compare equal and leave ALLOW.
 */
function parseTimelineInstant(iso: string): TimelineInstant | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?((?:Z|[+-]\d{2}:\d{2}))$/.exec(iso);
  if (!match) return null;
  const fraction = match[2] ?? '';
  const msDigits = fraction.slice(0, 3);
  const subMs = fraction.slice(3).replace(/0+$/, '');
  const msIso = msDigits.length > 0 ? `${match[1]}.${msDigits.padEnd(3, '0')}${match[3]}` : `${match[1]}${match[3]}`;
  const ms = Date.parse(msIso);
  if (!Number.isFinite(ms)) return null;
  return { ms, subMs };
}

function compareInstants(a: TimelineInstant, b: TimelineInstant): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  const width = Math.max(a.subMs.length, b.subMs.length);
  const left = a.subMs.padEnd(width, '0');
  const right = b.subMs.padEnd(width, '0');
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isDelimitedSectionLabel(evidence: string, index: number): boolean {
  if (index < 0) return false;
  if (index > 0 && !/\s/.test(evidence.charAt(index - 1))) return false;
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(evidence.charAt(cursor))) cursor--;
  if (cursor >= 0 && /["'“”‘’`]/.test(evidence.charAt(cursor))) return false;
  const lineStart = evidence.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const prefix = evidence.slice(lineStart, index);
  if (/["'“”‘’`]/.test(prefix)) return false;
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return true;
  return SECTION_LABELS.some((label) => trimmed.startsWith(label));
}

function nextDelimitedLabel(evidence: string, from: number): number {
  let best = -1;
  for (const label of SECTION_LABELS) {
    let at = evidence.indexOf(label, from);
    while (at !== -1) {
      if (isDelimitedSectionLabel(evidence, at)) {
        if (best < 0 || at < best) best = at;
        break;
      }
      at = evidence.indexOf(label, at + label.length);
    }
  }
  return best;
}

/**
 * A post-execution section is a delimited heading with a non-empty body.
 * An empty heading, a quoted heading, or the same words inside prose are not.
 */
function hasNonEmptyPostExecutionSection(evidence: string): boolean {
  for (const label of POST_SECTION_LABELS) {
    let at = evidence.indexOf(label);
    while (at !== -1) {
      if (isDelimitedSectionLabel(evidence, at)) {
        const bodyStart = at + label.length;
        const next = nextDelimitedLabel(evidence, bodyStart);
        const body = (next < 0 ? evidence.slice(bodyStart) : evidence.slice(bodyStart, next)).trim();
        if (body.length > 0) return true;
      }
      at = evidence.indexOf(label, at + label.length);
    }
  }
  return false;
}

/**
 * Explicit markers only. Section order is never a marker. Markers may only
 * downgrade. Two questions: (1) execution time, (2) a later per-item creation.
 */
export function detectPostExecutionEvidence(evidence: string): ActionAuthTimelineDetection {
  const ev = evidence ?? '';
  // Global regexes keep lastIndex. Reset so a later call still sees every marker.
  EXECUTED_RE.lastIndex = 0;
  CREATED_RE.lastIndex = 0;
  const basis: string[] = [];
  if (hasNonEmptyPostExecutionSection(ev)) basis.push('post_execution_section');
  // Several execution markers: the earliest one at full stated precision.
  const execs = [...ev.matchAll(EXECUTED_RE)]
    .map((m) => ({ iso: m[1] ?? '', instant: parseTimelineInstant(m[1] ?? '') }))
    .filter((x): x is { iso: string; instant: TimelineInstant } => x.instant !== null)
    .sort((a, b) => compareInstants(a.instant, b.instant));
  const executed = execs[0] ?? null;
  if (executed) {
    for (const m of ev.matchAll(CREATED_RE)) {
      const created = parseTimelineInstant(m[2] ?? '');
      if (created && compareInstants(created, executed.instant) > 0) {
        basis.push(
          `created_after_execution:${(m[1] ?? '').toLowerCase().replace(/ /g, '_')}=${m[2]}>executed_at=${executed.iso}`,
        );
      }
    }
  }
  const post_execution = basis.length > 0;
  return {
    post_execution,
    basis,
    execution_marker: executed !== null,
    executed_at: executed?.iso ?? null,
    hint_variant: post_execution ? 'post_execution_evidence' : executed ? 'execution_marker_only' : 'no_marker',
    action_labelled_proposed: PROPOSED_LABEL_RE.test(ev),
  };
}

export function neutralizeCallerTimelineHint(evidence: string): string {
  return (evidence ?? '')
    .split('\n')
    .map((line) => (line.toLowerCase().includes(TIMELINE_HINT_KEYWORD) ? CALLER_TIMELINE_HINT_REDACTION : line))
    .join('\n');
}

/** Public reasoning when the downgrade-only floor replaces an ALLOW. */
export function postExecutionFloorReasoning(basis: readonly string[]): string {
  const evidence = basis.length > 0 ? basis.join('; ') : 'post_execution_section';
  return (
    'Deterministic downgrade: post-execution evidence requires review, so the public verdict is UNCERTAIN rather than ALLOW. ' +
    `Evidence marked as created after execution: ${evidence}.`
  );
}

/** "Section order does not establish chronology. The execution time is unknown." */
export const TIMELINE_NEUTRAL_TEXT =
  'Section order does not establish chronology. The execution time is unknown.';

export const TIMELINE_PROPOSED_LABEL_TEXT =
  'The request labels the action as proposed; this label is stated as given and does not establish when, or whether, the action was executed.';

export function timelineHint(d: ActionAuthTimelineDetection): string {
  const label = d.action_labelled_proposed ? ` ${TIMELINE_PROPOSED_LABEL_TEXT}` : '';
  if (d.hint_variant === 'no_marker') {
    return `${SENTINEL_TIMELINE_HINT_LABEL} ${TIMELINE_NEUTRAL_TEXT}${label}`;
  }
  const execText = d.executed_at
    ? `The evidence states that the action was executed at ${d.executed_at}.`
    : 'The execution time is unknown.';
  if (d.hint_variant === 'execution_marker_only') {
    return (
      `${SENTINEL_TIMELINE_HINT_LABEL} Section order does not establish chronology. ${execText} ` +
      'No evidence item carries its own creation timestamp later than that execution time, and no item is in a POST-EXECUTION EVIDENCE section; the execution marker alone does not make any evidence post hoc.' +
      label
    );
  }
  return (
    `${SENTINEL_TIMELINE_HINT_LABEL} Section order does not establish chronology. ${execText} ` +
    `The following evidence items are explicitly marked as created after execution: ${d.basis.join('; ')}. ` +
    'Apply the post-hoc rule (F2) only to steps whose justification relies on these items.' +
    label
  );
}

export const POST_EXECUTION_EVIDENCE_REVIEW_REASON = 'post_execution_evidence_review';

/**
 * Downgrade-only. Public ALLOW becomes UNCERTAIN when post-hoc evidence is
 * present. BLOCK and UNCERTAIN are returned unchanged. Never upgrades.
 */
export function applyTimelineFloor<T extends string>(
  preFloorVerdict: 'ALLOW' | 'BLOCK' | 'UNCERTAIN',
  preFloorReason: T,
  postExecution: boolean,
): {
  verdict: 'ALLOW' | 'BLOCK' | 'UNCERTAIN';
  reason: T | typeof POST_EXECUTION_EVIDENCE_REVIEW_REASON;
  floor_applied: boolean;
} {
  if (postExecution && preFloorVerdict === 'ALLOW') {
    return {
      verdict: 'UNCERTAIN',
      reason: POST_EXECUTION_EVIDENCE_REVIEW_REASON,
      floor_applied: true,
    };
  }
  return { verdict: preFloorVerdict, reason: preFloorReason, floor_applied: false };
}
