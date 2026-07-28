/**
 * GET /.well-known/intuition/erc8004/agents/:chainId/:tokenId/trust-assessment.json
 *
 * Per-action ThoughtProof trust assessment for an ERC-8004 agent.
 *
 * This is NOT a reputation score. Each document is a snapshot of one
 * specific per-action verdict emitted by /sentinel/verify against the
 * agent identity (chainId + tokenId). Aggregating these into a
 * cross-time reputation score is out of scope and explicitly guarded
 * against inside each document (`important_do_not_do`).
 *
 * Convention mirrors AsterPay KYA:
 *   api.asterpay.io/.well-known/intuition/erc8004/agents/8453/1380/trust-assessment.json
 *
 * Only agents with a corresponding
 *   data/intuition/erc8004/agents/<chainId>/<tokenId>/trust-assessment.json
 * file are served; all other lookups return 404. Future documents can be
 * added by dropping a JSON file at the matching path.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CHAIN_ID_RE = /^\d{1,10}$/;
const TOKEN_ID_RE = /^\d{1,78}$/; // uint256 fits in 78 decimal digits

function firstQueryString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const chainId = firstQueryString(req.query.chainId);
  const tokenId = firstQueryString(req.query.tokenId);

  if (!chainId || !tokenId || !CHAIN_ID_RE.test(chainId) || !TOKEN_ID_RE.test(tokenId)) {
    return res.status(400).json({
      error: 'Bad request',
      detail: 'chainId must be a decimal integer; tokenId must be an unsigned integer',
    });
  }

  // Resolve to a canonical path inside the data directory and refuse anything
  // that escapes it (defense in depth — the Vercel router already prevents
  // this via the [chainId]/[tokenId] segments, but strict-check anyway).
  const dataRoot = resolve(process.cwd(), 'data/intuition/erc8004/agents');
  const filePath = resolve(dataRoot, chainId, tokenId, 'trust-assessment.json');
  if (!filePath.startsWith(dataRoot + '/') && filePath !== dataRoot) {
    return res.status(400).json({ error: 'Bad request' });
  }

  if (!existsSync(filePath)) {
    return res.status(404).json({
      error: 'Not found',
      detail:
        'ThoughtProof does not publish a trust assessment for this ERC-8004 agent. ' +
        'Per-action verdicts are only published by explicit opt-in; absence of a ' +
        'document is not evidence of anything about the agent.',
    });
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read assessment' });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return res.status(500).json({ error: 'Malformed assessment on disk' });
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'HEAD') return res.status(200).end();
  return res.status(200).json(body);
}
