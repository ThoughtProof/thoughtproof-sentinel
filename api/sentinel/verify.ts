import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateVerifyRequest } from '../../src/validation.js';
import { verify } from '../../src/engine/index.js';
import { buildAttestationData } from '../../src/eas/attest.js';
import { buildBillingEvent } from '../../src/billing.js';
import { validateApiKey, checkRateLimit, checkGlobalRateLimit } from '../../src/auth.js';
import type { PaymentPlatform } from '../../src/types.js';

const VERSION = '0.1.0';
const VALID_PLATFORMS: PaymentPlatform[] = ['openserv', 'acp', 'direct'];
const MAX_BODY_SIZE = 1_000_000; // 1MB

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    // --- Standard Headers ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sentinel-Key, X-Sentinel-Platform, X-Sentinel-Agent-Id');
    res.setHeader('X-Sentinel-Version', VERSION);
    res.setHeader('X-Request-Id', requestId);

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', allowed: ['POST'] });
    }

    // --- Content-Type + Body Size ---
    const contentType = req.headers['content-type'];
    if (contentType && !contentType.includes('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json', code: 'UNSUPPORTED_MEDIA_TYPE' });
    }

    if (req.body && JSON.stringify(req.body).length > MAX_BODY_SIZE) {
      return res.status(413).json({ error: 'Request too large', code: 'PAYLOAD_TOO_LARGE', max_bytes: MAX_BODY_SIZE });
    }

    // --- Auth (Phase 0: open, Phase 1: X-Sentinel-Key) ---
    const authResult = validateApiKey(req.headers['x-sentinel-key'] as string | undefined);
    if (!authResult.valid) {
      return res.status(401).json({ error: authResult.error, code: 'UNAUTHORIZED' });
    }

    // --- Rate Limiting (Upstash Redis or in-memory fallback) ---
    const rateLimitKey = (req.headers['x-sentinel-key'] as string) ?? req.headers['x-forwarded-for'] as string ?? 'anonymous';
    const rateLimit = authResult.valid && req.headers['x-sentinel-key']
      ? await checkRateLimit(rateLimitKey, 120) // Authenticated: 120/min
      : await checkGlobalRateLimit();           // Unauthenticated: 30/min

    res.setHeader('X-RateLimit-Remaining', rateLimit.remaining.toString());

    if (!rateLimit.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        code: 'RATE_LIMITED',
        remaining: 0,
        retry_after_ms: ('resetAt' in rateLimit) ? (rateLimit as { resetAt: number }).resetAt - Date.now() : 60_000,
      });
    }

    // --- Request Validation ---
    const result = validateVerifyRequest(req.body);
    if (!result.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        code: 'INVALID_REQUEST',
        details: (result as { valid: false; errors: unknown[] }).errors,
      });
    }

    // --- Platform Detection ---
    const rawPlatform = req.headers['x-sentinel-platform'] as string | undefined;
    const platform: PaymentPlatform = (rawPlatform && VALID_PLATFORMS.includes(rawPlatform as PaymentPlatform))
      ? rawPlatform as PaymentPlatform
      : authResult.platform ?? 'direct';
    const agentId = (req.headers['x-sentinel-agent-id'] as string | undefined) ?? authResult.agent_id;

    // --- Engine call — pure verification ---
    const response = await verify(result.data);

    // --- Response Validation ---
    if (!response.verdict || !['ALLOW', 'BLOCK', 'UNCERTAIN'].includes(response.verdict)) {
      console.error(`[sentinel/verify:${requestId}] invalid engine response: verdict=${response.verdict}`);
      return res.status(502).json({ error: 'Engine returned invalid response', code: 'ENGINE_ERROR' });
    }

    // --- EAS attestation data (prepared, not issued in Phase 0) ---
    const attestationData = buildAttestationData(result.data, response);

    // --- Billing event (logged, not settled in Phase 0) ---
    const billingEvent = buildBillingEvent(response, { platform, agent_id: agentId });

    console.log(`[sentinel/verify:${requestId}] verdict=${response.verdict} confidence=${response.confidence} tier=${response.tier} mode=${response.mode} duration=${response.meta.duration_ms}ms platform=${platform} agent=${agentId ?? 'none'}`);

    // Return enriched response with attestation + billing metadata
    return res.status(200).json({
      ...response,
      attestation: {
        prepared: true,
        issued: false, // Phase 0: no on-chain issuance yet
        schema_uid: '0x3945d7be65761ff1a83a4d6e16a7d3adbe6ced982a7e139854b5bfe4c0748d2b',
        claim_hash: attestationData.claimHash,
        evidence_hash: attestationData.evidenceHash,
      },
      billing: {
        price_usd: billingEvent.price_usd,
        settled: false, // Phase 0: no payment yet
        platform: billingEvent.platform,
      },
    });
  } catch (error) {
    console.error(`[sentinel/verify:${requestId}] error:`, error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    // Never expose internal error details to clients
    const safeMessage = message.includes('SERV') || message.includes('ATTESTER')
      ? 'Verification service temporarily unavailable'
      : message;
    res.status(500).json({ error: safeMessage, code: 'INTERNAL_ERROR', request_id: requestId });
  }
}
