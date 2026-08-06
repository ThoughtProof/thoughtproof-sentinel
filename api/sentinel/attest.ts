import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateApiKey, checkRateLimit, checkGlobalRateLimit } from '../../src/auth.js';
import { loadCachedVerifyResponse } from '../../src/verdict-cache.js';
import {
  issueSignFromVerifyResponse,
  isSignIssuanceConfigured,
  ISSUE_LEVEL_SIGN,
} from '../../src/issue-sign.js';
import { SENTINEL_EAS_CONFIG } from '../../src/eas-config.js';

const VERSION = '0.1.0';

/**
 * POST /sentinel/attest
 *
 * L1: issue Ed25519 signature over JCS canonical verdict for a prior verify id.
 * Requires the verify response to still be in short-TTL cache (Upstash).
 *
 * Body: { "verificationId": "sent_…", "level": "sign" }
 * Auth: X-Sentinel-Key (same as verify)
 *
 * For in-request issuance without cache, use verify with header:
 *   X-Sentinel-Issue: sign
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Sentinel-Key, X-Sentinel-Platform',
    );
    res.setHeader('X-Sentinel-Version', VERSION);
    res.setHeader('X-Request-Id', requestId);

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
    }

    const authResult = validateApiKey(req.headers['x-sentinel-key'] as string | undefined);
    if (!authResult.valid) {
      return res.status(401).json({ error: authResult.error, code: 'UNAUTHORIZED' });
    }

    const rateLimitKey =
      (req.headers['x-sentinel-key'] as string) ??
      (req.headers['x-forwarded-for'] as string) ??
      'anonymous';
    const rateLimit =
      authResult.valid && req.headers['x-sentinel-key']
        ? await checkRateLimit(rateLimitKey, 60)
        : await checkGlobalRateLimit();
    res.setHeader('X-RateLimit-Remaining', rateLimit.remaining.toString());
    if (!rateLimit.allowed) {
      return res.status(429).json({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' });
    }

    const body = req.body ?? {};
    const verificationId = typeof body.verificationId === 'string' ? body.verificationId.trim() : '';
    const level = typeof body.level === 'string' ? body.level : 'sign';

    if (!verificationId || !verificationId.startsWith('sent_')) {
      return res.status(400).json({
        error: 'verificationId required (sent_…)',
        code: 'INVALID_REQUEST',
      });
    }
    if (level !== 'sign') {
      return res.status(400).json({
        error: 'Only level=sign is supported in L1 (EAS is separate opt-in on verify)',
        code: 'UNSUPPORTED_LEVEL',
        supported: ['sign'],
      });
    }
    if (!isSignIssuanceConfigured()) {
      return res.status(503).json({
        error: 'Sign issuance not configured on this deployment',
        code: 'ISSUANCE_NOT_CONFIGURED',
      });
    }

    const cached = await loadCachedVerifyResponse(verificationId);
    if (!cached) {
      return res.status(404).json({
        error:
          'verificationId not in cache (expired or never stored). Re-verify with header X-Sentinel-Issue: sign, or attest within 24h of verify on a deployment with Upstash.',
        code: 'VERIFICATION_NOT_FOUND',
        verificationId,
      });
    }

    const attestation = issueSignFromVerifyResponse(cached, {
      schema_uid: SENTINEL_EAS_CONFIG.schemas.sentinelQualified.uid,
    });

    console.log(
      `[sentinel/attest:${requestId}] issued L1 sign verificationId=${verificationId} hash=${attestation.canonicalHash.slice(0, 18)}…`,
    );

    return res.status(200).json({
      ok: true,
      level: ISSUE_LEVEL_SIGN,
      verificationId,
      attestation,
    });
  } catch (error) {
    console.error(`[sentinel/attest:${requestId}] error:`, error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    const safe = message.includes('PRIVATE_KEY') || message.includes('not configured')
      ? 'Issuance temporarily unavailable'
      : message;
    return res.status(500).json({ error: safe, code: 'INTERNAL_ERROR', request_id: requestId });
  }
}
