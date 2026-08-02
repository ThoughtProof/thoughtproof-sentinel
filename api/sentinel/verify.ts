import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateVerifyRequest } from '../../src/validation.js';
import { verify } from '../../src/engine/index.js';
import { buildAttestationData, issueAttestation } from '../../src/eas/attest.js';
import { buildBillingEvent, recordBillingEvent } from '../../src/billing.js';
import { validateApiKey, checkRateLimit, checkGlobalRateLimit } from '../../src/auth.js';
import { x402Gate } from '../../src/middleware/x402.js';
import { processSignedEvidence, applyEvidenceEffects } from '../../src/evidence-processing.js';
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sentinel-Key, X-Sentinel-Platform, X-Sentinel-Agent-Id, X-Sentinel-Attest, X-Sentinel-Attest-Recipient');
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

    // --- x402 Payment Gate (after auth, before engine) ---
    const paymentResult = await x402Gate(req, res);
    if (!paymentResult.allowed) {
      return; // Gate already sent the 402/4xx response
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

    // --- Evidence Processing (F1) ---
    const evidenceResult = processSignedEvidence(result.data);
    const processedResponse = applyEvidenceEffects(response, evidenceResult, result.data);

    // --- Response Validation ---
    if (!processedResponse.verdict || !['ALLOW', 'BLOCK', 'UNCERTAIN'].includes(processedResponse.verdict)) {
      console.error(`[sentinel/verify:${requestId}] invalid processed response: verdict=${processedResponse.verdict}`);
      return res.status(502).json({ error: 'Engine returned invalid response', code: 'ENGINE_ERROR' });
    }

    // --- EAS attestation (opt-in via X-Sentinel-Attest header) ---
    const attestationData = buildAttestationData(result.data, processedResponse);
    const wantsAttestation = req.headers['x-sentinel-attest'] === 'true';
    const attestationEnabled = !!process.env.ATTESTER_PRIVATE_KEY;
    let attestationResult: { uid: string; txHash: string } | null = null;

    if (wantsAttestation && attestationEnabled && processedResponse.verdict === 'ALLOW') {
      try {
        const recipient = (req.headers['x-sentinel-attest-recipient'] as string) ?? undefined;
        const result = await issueAttestation(attestationData, { recipient });
        attestationResult = { uid: result.uid, txHash: result.txHash };
        console.log(`[sentinel/verify:${requestId}] attestation issued: uid=${result.uid} tx=${result.txHash}`);
      } catch (attestError) {
        // Attestation failure should NOT block the verification response
        console.error(`[sentinel/verify:${requestId}] attestation failed:`, attestError instanceof Error ? attestError.message : attestError);
      }
    }

    // --- Billing event (logged + Stripe meter if configured) ---
    const billingEvent = buildBillingEvent(processedResponse, { platform, agent_id: agentId });
    await recordBillingEvent(billingEvent);

    console.log(`[sentinel/verify:${requestId}] verdict=${processedResponse.verdict} confidence=${processedResponse.confidence} tier=${processedResponse.tier} mode=${processedResponse.mode} duration=${processedResponse.meta.duration_ms}ms platform=${platform} agent=${agentId ?? 'none'}${processedResponse.meta.evidence_verification ? ` evidence=${processedResponse.meta.evidence_verification.length}` : ''}${processedResponse.meta.proof_strength ? ` proof=${processedResponse.meta.proof_strength}` : ''}`);

    // Return enriched response with attestation + billing metadata
    return res.status(200).json({
      ...processedResponse,
      attestation: {
        prepared: true,
        issued: !!attestationResult,
        schema_uid: '0x3945d7be65761ff1a83a4d6e16a7d3adbe6ced982a7e139854b5bfe4c0748d2b',
        claim_hash: attestationData.claimHash,
        evidence_hash: attestationData.evidenceHash,
        ...(attestationResult && {
          uid: attestationResult.uid,
          tx_hash: attestationResult.txHash,
        }),
      },
      billing: {
        price_usd: billingEvent.price_usd,
        settled: paymentResult.paymentMethod === 'x402-facilitator' || paymentResult.paymentMethod === 'intent',
        platform: billingEvent.platform,
        ...(paymentResult.paymentMethod && { payment_method: paymentResult.paymentMethod }),
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
