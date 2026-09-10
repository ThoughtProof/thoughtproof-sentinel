/**
 * Upstash REST env resolution — no Redis / Ratelimit imports.
 *
 * Used by `/sentinel/health` so liveness cannot fail because the limiter
 * SDK or a JSON policy module failed to load on Vercel Node.
 */

/** Single source for health `rate_limit` values. Re-exported from types.ts / auth.ts. */
export type RateLimitBackend = 'redis' | 'in_memory' | 'unavailable';

const URL_ENV = 'UPSTASH_' + 'REDIS_' + 'REST_' + 'URL';
const TOKEN_ENV = 'UPSTASH_' + 'REDIS_' + 'REST_' + 'TOKEN';

export type UpstashResolveResult =
  | {
      status: 'configured';
      url: string;
      token: string;
      /** True when either raw value differed from its trimmed form. */
      trimmed: boolean;
    }
  | { status: 'missing' }
  | {
      status: 'invalid';
      reason: 'empty_after_trim' | 'internal_whitespace' | 'url_not_http';
      trimmed: boolean;
    };

let _warnedTrim = false;
let _warnedInvalid = false;

function rawEnv(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const v = env[name];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Resolve Upstash REST credentials. Never returns secret material beyond the
 * trimmed url/token to the caller that already needs them for Redis init.
 */
export function resolveUpstashConfig(
  env: NodeJS.ProcessEnv = process.env,
): UpstashResolveResult {
  const rawUrl = rawEnv(URL_ENV, env);
  const rawToken = rawEnv(TOKEN_ENV, env);

  if (rawUrl === undefined && rawToken === undefined) {
    return { status: 'missing' };
  }
  if (rawUrl === undefined || rawToken === undefined) {
    return { status: 'invalid', reason: 'empty_after_trim', trimmed: false };
  }

  const url = rawUrl.trim();
  const token = rawToken.trim();
  const trimmed = url !== rawUrl || token !== rawToken;

  if (!url || !token) {
    return { status: 'invalid', reason: 'empty_after_trim', trimmed };
  }

  if (/\s/.test(url) || /\s/.test(token)) {
    return { status: 'invalid', reason: 'internal_whitespace', trimmed };
  }

  if (!/^https?:\/\//i.test(url)) {
    return { status: 'invalid', reason: 'url_not_http', trimmed };
  }

  return { status: 'configured', url, token, trimmed };
}

/** Log once per cold start when trim repaired env whitespace (no secrets). */
export function warnIfUpstashTrimmed(cfg: UpstashResolveResult): void {
  if (cfg.status === 'configured' && cfg.trimmed && !_warnedTrim) {
    _warnedTrim = true;
    console.warn(
      '[sentinel/upstash] UPSTASH_REDIS_REST_URL/TOKEN contained leading/trailing whitespace; trimmed at client init. Re-set the Vercel env without newlines.',
    );
  }
  if (cfg.status === 'invalid' && !_warnedInvalid) {
    _warnedInvalid = true;
    console.error(
      `[sentinel/upstash] UPSTASH_REDIS_REST_* is set but invalid (${cfg.reason}). Rate limit will fail closed when Redis is required.`,
    );
  }
}

export function isUpstashConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveUpstashConfig(env).status === 'configured';
}

/**
 * Limiter-store readiness for `/sentinel/health` (issue #43).
 * Config probe only — no Redis I/O / PING.
 * `redis` means Upstash REST URL+token **configured**, not that
 * connectivity was checked. `limit()` can still 503.
 */
export function getRateLimitReadiness(
  env: NodeJS.ProcessEnv = process.env,
): { rate_limit: RateLimitBackend } {
  const cfg = resolveUpstashConfig(env);
  if (cfg.status === 'configured') return { rate_limit: 'redis' };
  if (cfg.status === 'missing') return { rate_limit: 'in_memory' };
  return { rate_limit: 'unavailable' };
}

/** Test helper — drop one-shot warning flags. */
export function _resetUpstashEnvWarnings(): void {
  _warnedTrim = false;
  _warnedInvalid = false;
}
