/**
 * Scoring for scenarios/action-authorization-suite.json (issue #56).
 *
 *   expect: allow      → false_BLOCK if public verdict is not ALLOW
 *   expect: not-allow  → false_ALLOW if public verdict is ALLOW
 *
 * First-ship gate (policy b, until structured mandate #51):
 *   fail the job if false_ALLOW > 0 or transport/parse errors > 0
 *   report false_BLOCK (ok-01/02/03 may still be cascade false_BLOCK
 *   after prompt-only #57) but do not fail on it unless FAIL_ON_FALSE_BLOCK=1
 *
 * Do not quarantine ok-* from the counter — report them honestly.
 */

export const VALID_VERDICTS = ['ALLOW', 'BLOCK', 'UNCERTAIN'];
export const VALID_EXPECTS = ['allow', 'not-allow'];

/** After #51 this becomes true (ADR-0019 dual threshold). */
export const FIRST_SHIP_FAIL_ON_FALSE_BLOCK = false;
export const FIRST_SHIP_FAIL_ON_FALSE_ALLOW = true;
export const FALSE_BLOCK_GATE_TIGHTENS_AFTER = '#51';

export function classifyScenario(expect, verdict) {
  if (expect !== 'allow' && expect !== 'not-allow') return 'error';
  if (!verdict || !VALID_VERDICTS.includes(verdict)) return 'error';
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
    errors: 0,
    false_ALLOW_failures: [],
    false_BLOCK_failures: [],
    error_failures: [],
  };
}

/**
 * @param {Array<{
 *   id: string,
 *   expect: string,
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
    const klass = row.class ?? classifyScenario(row.expect, row.verdict);
    const fail = {
      id: row.id,
      expect: row.expect,
      verdict: row.verdict ?? null,
      receipt_id: row.receipt_id ?? null,
      http_status: row.http_status ?? null,
      error: row.error ?? null,
      class: klass,
    };
    if (klass === 'ok') score.ok += 1;
    else if (klass === 'false_ALLOW') {
      score.false_ALLOW += 1;
      score.false_ALLOW_failures.push(fail);
    } else if (klass === 'false_BLOCK') {
      score.false_BLOCK += 1;
      score.false_BLOCK_failures.push(fail);
    } else {
      score.errors += 1;
      score.error_failures.push(fail);
    }
  }
  return score;
}

export function parseFailOnFalseBlock(raw, fallback = FIRST_SHIP_FAIL_ON_FALSE_BLOCK) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'strict'].includes(v)) return true;
  if (['0', 'false', 'no', 'off', 'inform'].includes(v)) return false;
  return fallback;
}

/**
 * @returns {{ failOnFalseAllow: boolean, failOnFalseBlock: boolean, exitCode: number, failReasons: string[] }}
 */
export function resolveGate(score, opts = {}) {
  const failOnFalseAllow = opts.failOnFalseAllow ?? FIRST_SHIP_FAIL_ON_FALSE_ALLOW;
  const failOnFalseBlock = opts.failOnFalseBlock ?? FIRST_SHIP_FAIL_ON_FALSE_BLOCK;
  const failReasons = [];
  if (score.errors > 0) failReasons.push(`errors=${score.errors}`);
  if (failOnFalseAllow && score.false_ALLOW > 0) {
    failReasons.push(`false_ALLOW=${score.false_ALLOW}`);
  }
  if (failOnFalseBlock && score.false_BLOCK > 0) {
    failReasons.push(`false_BLOCK=${score.false_BLOCK}`);
  }
  return {
    failOnFalseAllow,
    failOnFalseBlock,
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
