# ThoughtProof Sentinel

Agentic verification API — lightweight verification for autonomous agent workflows.

## Endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/sentinel/health` | GET | Liveness (`ok`) + readiness (`ready`, `serv_key`, `rate_limit`). `rate_limit: "redis"` means Upstash env is configured, not connectivity-checked. |
| `/sentinel/tiers` | GET | Tier discovery |
| `/sentinel/verify` | POST | Verification (501 until engine wired) |

## Tiers

| Tier | Price | Cascade | Accuracy | FA |
|------|-------|---------|----------|-----|
| checkpoint | $0.003 | Nano solo | 83.3% | 0 |
| standard | $0.005 | Nano→Pro | 81.3% | 0 |

## Modes

- `handoff` — Inter-agent claim-packet verification
- `plan_revision` — Goal-drift detection at checkpoints
- `memory_write` — Self-summary faithfulness
- `output_synthesis` — Final report quality guard

## Development

```bash
npm install
npm test
vercel dev
```

## Action-authorization suite (issue #56)

Labeled drain / in-scope measurement against live production
`POST https://sentinel.thoughtproof.ai/sentinel/verify` (~10–15¢/night at
`standard`, 18 × $0.008). Nightly GitHub Action (plus `workflow_dispatch`;
also on PRs that touch the suite or engine). Preview is an optional
override for PR/dispatch only.

```bash
SENTINEL_NIGHTLY_API_KEY=… npm run suite:action-auth
# Preview override (PR / dispatch only):
SENTINEL_NIGHTLY_API_KEY=… SENTINEL_BASE_URL=https://<preview> npm run suite:action-auth
```

Use a **dedicated** Sentinel API key (secret `SENTINEL_NIGHTLY_API_KEY`).
Every request sets `X-Sentinel-Agent-Id: nightly-suite` (billing `agent_id`
and verify-log `agent=`) plus `agent_context.agent_id` so the 18 nightly
receipts can be filtered from organic traffic.

**First-ship baseline:** `false_ALLOW` must be **0**. `false_BLOCK` is a
**ratchet**: the job fails if the count exceeds named `FALSE_BLOCK_BASELINE = 4`
(today’s known cascade false_BLOCKs: ok-01 / ok-02 / ok-03 / ok-06). Changing
that constant requires a CHANGELOG line. After structured mandate
([#51](https://github.com/ThoughtProof/thoughtproof-sentinel/issues/51))
lower the baseline to 0. Counts are reported honestly (no quarantine).

**GitHub secrets / variables** (see comments in
`.github/workflows/action-authorization-suite.yml`):

| Name | Required | Purpose |
| --- | --- | --- |
| `SENTINEL_NIGHTLY_API_KEY` | yes (cron / dispatch) | dedicated `X-Sentinel-Key` |
| `SENTINEL_API_KEY` | fallback | same header if the nightly-named secret is unset |
| `SENTINEL_BASE_URL` | no (prod default) | Preview override for PR/dispatch only |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | only if hitting protected Preview | `x-vercel-protection-bypass` |
