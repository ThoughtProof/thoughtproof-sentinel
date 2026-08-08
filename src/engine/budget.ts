/**
 * Engine budget / fail-closed deadline (Reliability Option 3).
 *
 * Vercel maxDuration: 60s
 * Engine total budget: 45s  (cascade / provider work)
 * Reserve: 15s for mapping, promotion, bind, response
 *
 * On budget end:
 * - preserve already-known BLOCK
 * - else public REVIEW (UNCERTAIN wire)
 * - reason=engine_budget_exhausted
 * - degradedMode=true
 * - never ALLOW after timeout
 * - abort in-flight provider work; no late result overwrite
 */

export const VERCEL_MAX_DURATION_S = 60;
/** Cascade/provider wall inside the function. */
export const ENGINE_BUDGET_MS = 45_000;
/** Reserved after cascade for mapping/trace/response. */
export const ENGINE_RESERVE_MS = 15_000;

export const ENGINE_BUDGET_REASON = 'engine_budget_exhausted' as const;

export type BudgetStage =
  | 'pre_cascade'
  | 'primary'
  | 'secondary'
  | 'solo'
  | 'post_cascade'
  | 'unknown';

export interface BudgetTrace {
  reason: typeof ENGINE_BUDGET_REASON;
  degradedMode: true;
  stage: BudgetStage;
  elapsed_ms: number;
  budget_ms: number;
  reserve_ms: number;
  vercel_max_duration_s: number;
  known_internal_verdict: string | null;
  public_verdict: 'BLOCK' | 'UNCERTAIN';
  late_result_ignored: boolean;
}

export class EngineBudgetExhaustedError extends Error {
  readonly code = ENGINE_BUDGET_REASON;
  readonly stage: BudgetStage;
  readonly elapsedMs: number;
  readonly budgetMs: number;
  /** Restrictive partial knowledge only — BLOCK if already observed. */
  readonly knownInternalVerdict: string | null;
  readonly modelsUsed: string[];

  constructor(opts: {
    stage: BudgetStage;
    elapsedMs: number;
    budgetMs?: number;
    knownInternalVerdict?: string | null;
    modelsUsed?: string[];
  }) {
    super(
      `[engine-budget] exhausted at stage=${opts.stage} elapsed_ms=${opts.elapsedMs} budget_ms=${opts.budgetMs ?? ENGINE_BUDGET_MS}`,
    );
    this.name = 'EngineBudgetExhaustedError';
    this.stage = opts.stage;
    this.elapsedMs = opts.elapsedMs;
    this.budgetMs = opts.budgetMs ?? ENGINE_BUDGET_MS;
    this.knownInternalVerdict = opts.knownInternalVerdict ?? null;
    this.modelsUsed = opts.modelsUsed ?? [];
  }
}

export function isEngineBudgetExhaustedError(err: unknown): err is EngineBudgetExhaustedError {
  return err instanceof EngineBudgetExhaustedError;
}

/**
 * Public verdict on budget exhaustion.
 * Only preserve BLOCK; never ALLOW; everything else → UNCERTAIN (REVIEW).
 */
export function publicVerdictOnBudgetExhaust(
  knownInternalVerdict: string | null | undefined,
): 'BLOCK' | 'UNCERTAIN' {
  if (knownInternalVerdict === 'BLOCK') return 'BLOCK';
  return 'UNCERTAIN';
}

export function buildBudgetTrace(opts: {
  stage: BudgetStage;
  elapsedMs: number;
  knownInternalVerdict?: string | null;
  lateResultIgnored?: boolean;
  budgetMs?: number;
}): BudgetTrace {
  const known = opts.knownInternalVerdict ?? null;
  return {
    reason: ENGINE_BUDGET_REASON,
    degradedMode: true,
    stage: opts.stage,
    elapsed_ms: opts.elapsedMs,
    budget_ms: opts.budgetMs ?? ENGINE_BUDGET_MS,
    reserve_ms: ENGINE_RESERVE_MS,
    vercel_max_duration_s: VERCEL_MAX_DURATION_S,
    known_internal_verdict: known,
    public_verdict: publicVerdictOnBudgetExhaust(known),
    late_result_ignored: opts.lateResultIgnored === true,
  };
}

/**
 * Race a promise against an AbortSignal. On abort, rejects with
 * EngineBudgetExhaustedError. Late resolution of `work` is ignored by the
 * race winner (caller must not await work after abort for decisioning).
 */
export function raceAgainstBudget<T>(
  work: Promise<T>,
  opts: {
    signal: AbortSignal;
    stage: BudgetStage;
    startedAt: number;
    budgetMs?: number;
    knownInternalVerdict?: () => string | null;
    modelsUsed?: () => string[];
  },
): Promise<T> {
  if (opts.signal.aborted) {
    return Promise.reject(
      new EngineBudgetExhaustedError({
        stage: opts.stage,
        elapsedMs: Date.now() - opts.startedAt,
        budgetMs: opts.budgetMs,
        knownInternalVerdict: opts.knownInternalVerdict?.() ?? null,
        modelsUsed: opts.modelsUsed?.() ?? [],
      }),
    );
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new EngineBudgetExhaustedError({
          stage: opts.stage,
          elapsedMs: Date.now() - opts.startedAt,
          budgetMs: opts.budgetMs,
          knownInternalVerdict: opts.knownInternalVerdict?.() ?? null,
          modelsUsed: opts.modelsUsed?.() ?? [],
        }),
      );
    };

    const cleanup = () => {
      opts.signal.removeEventListener('abort', onAbort);
    };

    opts.signal.addEventListener('abort', onAbort, { once: true });

    work.then(
      (value) => {
        if (settled) return; // late result — ignored
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return; // late rejection — ignored
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}

/** Create AbortController that aborts when budget elapses from startedAt. */
export function startEngineBudget(opts?: {
  budgetMs?: number;
  startedAt?: number;
}): {
  controller: AbortController;
  startedAt: number;
  budgetMs: number;
  clear: () => void;
} {
  const budgetMs = opts?.budgetMs ?? ENGINE_BUDGET_MS;
  const startedAt = opts?.startedAt ?? Date.now();
  const controller = new AbortController();
  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(0, budgetMs - elapsed);
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort();
  }, remaining);
  // Don't keep process alive solely for the timer in tests.
  if (typeof timer === 'object' && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref?.();
  }
  return {
    controller,
    startedAt,
    budgetMs,
    clear: () => clearTimeout(timer),
  };
}
