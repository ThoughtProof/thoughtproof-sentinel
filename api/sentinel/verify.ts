import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateVerifyRequest } from '../../src/validation.js';
import { verify } from '../../src/engine/index.js';
import { buildAttestationData, encodeAttestationData, hashToBytes32 } from '../../src/eas/attest.js';
import { buildBillingEvent } from '../../src/billing.js';
import type { PaymentPlatform } from '../../src/types.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sentinel-Key');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', allowed: ['POST'] });
    }

    const contentType = req.headers['content-type'];
    if (contentType && !contentType.includes('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json', code: 'UNSUPPORTED_MEDIA_TYPE' });
    }

    const result = validateVerifyRequest(req.body);
    if (!result.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        code: 'INVALID_REQUEST',
        details: (result as { valid: false; errors: unknown[] }).errors,
      });
    }

    // --- Phase 0: Platform detection (no auth yet) ---
    const platform: PaymentPlatform = (req.headers['x-sentinel-platform'] as PaymentPlatform) ?? 'direct';
    const agentId = req.headers['x-sentinel-agent-id'] as string | undefined;

    // --- Engine call — pure verification ---
    const response = await verify(result.data);

    // --- EAS attestation data (prepared, not issued in Phase 0) ---
    const attestationData = buildAttestationData(result.data, response);

    // --- Billing event (logged, not settled in Phase 0) ---
    const billingEvent = buildBillingEvent(response, { platform, agent_id: agentId });

    console.log(`[sentinel/verify] id=${response.id} verdict=${response.verdict} tier=${response.tier} mode=${response.mode} duration=${response.meta.duration_ms}ms platform=${platform}`);

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
    console.error('[sentinel/verify] error:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message, code: 'INTERNAL_ERROR' });
  }
}
