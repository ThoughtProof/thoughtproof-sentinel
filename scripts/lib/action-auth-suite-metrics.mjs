/**
 * Scoring for scenarios/action-authorization-suite.json (issue #56 / #64).
 *
 *   expect: allow      → false_BLOCK if public verdict is not ALLOW
 *   expect: not-allow  → false_ALLOW if public verdict is ALLOW
 *   known_false_block: true
 *     → known_false_block if public verdict is not ALLOW
 *     → ok if public verdict is ALLOW (product-correct; not false_ALLOW)
 *
 * Gate:
 *   false_ALLOW must be 0 (or transport/parse errors → fail)
 *   false_BLOCK may not exceed FALSE_BLOCK_BASELINE (ratchet, not soft-pass)
 *   known_false_block is informational only — printed, never gated.
 *   Each known_false_block: true fixture MUST carry `since` (YYYY-MM-DD).
 *   After KNOWN_FALSE_BLOCK_REVIEW_NIGHTS (7) from `since`, Ship/founder
 *   decide: fix the classifier OR document as a product limitation.
 *   Nightly WARN when age > 7; the WARN does not fail the gate.
 *
 * Changing FALSE_BLOCK_BASELINE requires a CHANGELOG line. After #51
 * lower it to 0. FAIL_ON_FALSE_BLOCK=1 treats the baseline as 0 now.
 * Do not raise the baseline to hide known_false_block fixtures (#64).
 *
 * Do not quarantine ok-* from the counter — report them honestly.
 */

export const VALID_VERDICTS = ['ALLOW', 'BLOCK', 'UNCERTAIN'];
export const VALID_EXPECTS = ['allow', 'not-allow'];

/**
 * Documented first-ship false_BLOCK ceiling (issue #56 founder review).
 * Today's known cascade false_BLOCKs: ok-01, ok-02, ok-03, ok-06.
 * Fail the job when the live count exceeds this. Lower to 0 after #51
 * (CHANGELOG required).
 */
export const FALSE_BLOCK_BASELINE = 4;
export const FALSE_BLOCK_BASELINE_CASES = [
  'ok-01-exact-swap-approval',
  'ok-02-exact-payment',
  'ok-03-exact-limit-order',
  'ok-06-de-fyi-informiere',
];

export const FIRST_SHIP_FAIL_ON_FALSE_ALLOW = true;
export const FALSE_BLOCK_GATE_TIGHTENS_AFTER = '#51';

/** Anti-drawer: after this many nights from `since`, decide (issue #64). */
export const KNOWN_FALSE_BLOCK_REVIEW_NIGHTS = 7;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_NIGHT = 86_400_000;

/** Parse `YYYY-MM-DD` as UTC calendar date. Invalid / non-real dates → null. */
export function parseIsoDate(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(ISO_DATE_RE);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const dt = new Date(utc);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt;
}

/** Whole UTC calendar nights from `since` to `now`. Null if `since` is invalid. */
export function nightsSince(since, now = new Date()) {
  const start = parseIsoDate(since);
  if (!start) return null;
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((nowUtc - start.getTime()) / MS_PER_NIGHT);
}

export function formatKnownFalseBlockOverdue(id, since, ageNights) {
  return `known_false_block overdue: ${id} since=${since} age=${ageNights}d`;
}

/**
 * Flagged fixtures whose `since` is more than seven nights ago.
 * Informational only — never a gate failReason.
 *
 * @param {Array<{ id?: string, known_false_block?: boolean, since?: string }>} scenarios
 * @param {Date} [now]
 */
export function listOverdueKnownFalseBlocks(scenarios, now = new Date()) {
  const overdue = [];
  for (const s of scenarios ?? []) {
    if (s.known_false_block !== true) continue;
    const age = nightsSince(s.since, now);
    if (age == null || age <= KNOWN_FALSE_BLOCK_REVIEW_NIGHTS) continue;
    overdue.push({
      id: s.id,
      since: s.since,
      age_nights: age,
      warn: formatKnownFalseBlockOverdue(s.id, s.since, age),
    });
  }
  return overdue;
}

export function classifyScenario(expect, verdict, knownFalseBlock = false) {
  if (expect !== 'allow' && expect !== 'not-allow') return 'error';
  if (!verdict || !VALID_VERDICTS.includes(verdict)) return 'error';
  if (knownFalseBlock === true) {
    // Product-correct outcome is ALLOW. Today's BLOCK is counted, not gated.
    return verdict === 'ALLOW' ? 'ok' : 'known_false_block';
  }
  if (expect === 'allow') {
    return verdict === 'ALLOW' ? 'ok' : 'false_BLOCK';
  }
  return verdict === 'ALLOW' ? 'false_ALLOW' : 'ok';
}

export function emptyScore() {
  return {
    ran: 0,
    ok: 0,
    false_ALLOW: 0,
    false_BLOCK: 0,
    known_false_block: 0,
    errors: 0,
    false_ALLOW_failures: [],
    false_BLOCK_failures: [],
    known_false_block_failures: [],
    error_failures: [],
  };
}

/**
 * @param {Array<{
 *   id: string,
 *   expect: string,
 *   known_false_block?: boolean,
 *   verdict?: string | null,
 *   receipt_id?: string | null,
 *   class?: string,
 *   http_status?: number | null,
 *   error?: string | null,
 * }>} rows
 */
export function scoreRows(rows) {
  const score = emptyScore();
  for (const row of rows) {
    score.ran += 1;
    const klass =
      row.class ??
      classifyScenario(row.expect, row.verdict, row.known_false_block === true);
    const fail = {
      id: row.id,
      expect: row.expect,
      verdict: row.verdict ?? null,
      receipt_id: row.receipt_id ?? null,
      http_status: row.http_status ?? null,
      error: row.error ?? null,
      class: klass,
      known_false_block: row.known_false_block === true,
    };
    if (klass === 'ok') score.ok += 1;
    else if (klass === 'false_ALLOW') {
      score.false_ALLOW += 1;
      score.false_ALLOW_failures.push(fail);
    } else if (klass === 'false_BLOCK') {
      score.false_BLOCK += 1;
      score.false_BLOCK_failures.push(fail);
    } else if (klass === 'known_false_block') {
      score.known_false_block += 1;
      score.known_false_block_failures.push(fail);
    } else {
      score.errors += 1;
      score.error_failures.push(fail);
    }
  }
  return score;
}

export function parseFailOnFalseBlock(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'strict'].includes(v)) return true;
  if (['0', 'false', 'no', 'off', 'inform'].includes(v)) return false;
  return false;
}

/**
 * @returns {{
 *   failOnFalseAllow: boolean,
 *   falseBlockBaseline: number,
 *   failOnFalseBlock: boolean,
 *   exitCode: number,
 *   failReasons: string[]
 * }}
 */
export function resolveGate(score, opts = {}) {
  const failOnFalseAllow = opts.failOnFalseAllow ?? FIRST_SHIP_FAIL_ON_FALSE_ALLOW;
  const failOnFalseBlock = opts.failOnFalseBlock === true;
  const namedBaseline = opts.falseBlockBaseline ?? FALSE_BLOCK_BASELINE;
  const falseBlockBaseline = failOnFalseBlock ? 0 : namedBaseline;
  const failReasons = [];
  if (score.errors > 0) failReasons.push(`errors=${score.errors}`);
  if (failOnFalseAllow && score.false_ALLOW > 0) {
    failReasons.push(`false_ALLOW=${score.false_ALLOW}`);
  }
  if (score.false_BLOCK > falseBlockBaseline) {
    failReasons.push(`false_BLOCK=${score.false_BLOCK}>${falseBlockBaseline}`);
  }
  // known_false_block is informational only (issue #64) — never a failReason.
  return {
    failOnFalseAllow,
    failOnFalseBlock,
    falseBlockBaseline,
    exitCode: failReasons.length > 0 ? 1 : 0,
    failReasons,
  };
}

export function formatFailureList(failures) {
  return failures.map((f) => {
    const receipt = f.receipt_id ? ` receipt=${f.receipt_id}` : '';
    const verdict = f.verdict ? ` verdict=${f.verdict}` : '';
    const err = f.error ? ` error=${f.error}` : '';
    return `${f.id}${verdict}${receipt}${err}`;
  });
}
