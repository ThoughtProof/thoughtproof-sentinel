/**
 * Short-TTL cache of verify responses for POST /sentinel/attest lookup by id.
 * Uses Upstash when configured; no-op otherwise (in-request X-Sentinel-Issue still works).
 */
import { Redis } from '@upstash/redis';
import type { SentinelVerifyResponse } from './types.js';

const PREFIX = 'sentinel:vr:';
const TTL_SEC = 60 * 60 * 24; // 24h

let _redis: Redis | null | undefined;

function redis(): Redis | null {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    _redis = null;
    return null;
  }
  _redis = new Redis({ url, token });
  return _redis;
}

/** Test helper */
export function _resetVerdictCache(): void {
  _redis = undefined;
}

export async function cacheVerifyResponse(response: SentinelVerifyResponse): Promise<void> {
  const r = redis();
  if (!r || !response?.id) return;
  try {
    // Store only fields needed to rebuild canonical + show claim/evidence hashes later
    const slim = {
      id: response.id,
      verdict: response.verdict,
      confidence: response.confidence,
      reasoning: response.reasoning,
      objections: response.objections,
      mode: response.mode,
      tier: response.tier,
      meta: response.meta,
      ...(response.gate ? { gate: response.gate } : {}),
    };
    await r.set(`${PREFIX}${response.id}`, JSON.stringify(slim), { ex: TTL_SEC });
  } catch (e) {
    console.error('[verdict-cache] set failed:', e instanceof Error ? e.message : e);
  }
}

export async function loadCachedVerifyResponse(
  verificationId: string,
): Promise<SentinelVerifyResponse | null> {
  const r = redis();
  if (!r || !verificationId) return null;
  try {
    const raw = await r.get<string>(`${PREFIX}${verificationId}`);
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed as SentinelVerifyResponse;
  } catch (e) {
    console.error('[verdict-cache] get failed:', e instanceof Error ? e.message : e);
    return null;
  }
}
