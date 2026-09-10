/**
 * Verifier model-config readiness.
 *
 * Sentinel's cascade (serv-nano / serv-swift) requires SERV_API_KEY.
 * Health reports presence only — never the key value. Verify maps a missing
 * required model env to HTTP 503 MODEL_CONFIG_MISSING (gate-down), not 500
 * INTERNAL_ERROR (which MCP hosts would treat as model uncertainty).
 */

export const SERV_API_KEY_ENV = 'SERV_API_KEY';

/** Dedicated verify error code: gate-down ≠ cascade UNCERTAIN. */
export const MODEL_CONFIG_ERROR_CODE = 'MODEL_CONFIG_MISSING' as const;

export const MODEL_CONFIG_ERROR_MESSAGE =
  'Verification service temporarily unavailable';

export type ServKeyPresence = 'present' | 'missing';

export interface ModelReadiness {
  /** Cascade can run (required model env is configured). */
  ready: boolean;
  /** SERV_API_KEY presence only — never the secret. */
  serv_key: ServKeyPresence;
}

/** pot-cli `callModelStructured` / `callOpenAICompat`: `Missing env: SERV_API_KEY`. */
const MISSING_ENV_RE = /Missing env:\s*([A-Z][A-Z0-9_]*)/;

function envPresent(name: string, env: NodeJS.ProcessEnv): boolean {
  const value = env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Readiness for the SERV cascade. `env` is injectable for tests.
 * Return value must never include secret material.
 */
export function getModelReadiness(
  env: NodeJS.ProcessEnv = process.env,
): ModelReadiness {
  const serv_key: ServKeyPresence = envPresent(SERV_API_KEY_ENV, env)
    ? 'present'
    : 'missing';
  return {
    ready: serv_key === 'present',
    serv_key,
  };
}

export function isModelConfigReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return getModelReadiness(env).ready;
}

/**
 * True when pot-cli (or a wrapper) failed because a required model API key
 * env is missing. Matches the env *name* in the message, never a secret value.
 */
export function isModelConfigError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(MISSING_ENV_RE);
  if (!match) return false;
  const name = match[1];
  return name === SERV_API_KEY_ENV || name.endsWith('_API_KEY');
}

export function modelConfigUnavailablePayload(requestId: string): {
  error: typeof MODEL_CONFIG_ERROR_MESSAGE;
  code: typeof MODEL_CONFIG_ERROR_CODE;
  request_id: string;
} {
  return {
    error: MODEL_CONFIG_ERROR_MESSAGE,
    code: MODEL_CONFIG_ERROR_CODE,
    request_id: requestId,
  };
}
