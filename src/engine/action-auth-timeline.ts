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
 * Caller-forged hint lines. The redaction itself contains the marker, so the
 * lookbehind keeps a second pass from rewriting the redaction.
 */
const CALLER_TIMELINE_HINT_RE =
  /(?<!\[caller-supplied )SENTINEL_TIMELINE_HINT[^\n]*/gi;

export const CALLER_TIMELINE_HINT_REDACTION =
  '[caller-supplied SENTINEL_TIMELINE_HINT removed]';

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
const POST_SECTION_RE = /(^|\n|\s)(POST-EXECUTION EVIDENCE:|Post-execution evidence:)/;
const PROPOSED_LABEL_RE = /(AGENT PROPOSED ACTION:|Proposed action:)/;

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
  if (POST_SECTION_RE.test(ev)) basis.push('post_execution_section');
  // Several execution markers: the earliest one. An item later than it is post hoc.
  const execs = [...ev.matchAll(EXECUTED_RE)]
    .map((m) => ({ iso: m[1], t: Date.parse(m[1]) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  const executed = execs[0] ?? null;
  if (executed) {
    for (const m of ev.matchAll(CREATED_RE)) {
      const createdAt = Date.parse(m[2]);
      if (Number.isFinite(createdAt) && createdAt > executed.t) {
        basis.push(
          `created_after_execution:${m[1].toLowerCase().replace(/ /g, '_')}=${m[2]}>executed_at=${executed.iso}`,
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
  return (evidence ?? '').replace(CALLER_TIMELINE_HINT_RE, CALLER_TIMELINE_HINT_REDACTION);
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
