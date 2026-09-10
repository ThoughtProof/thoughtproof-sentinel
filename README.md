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

Labeled drain / in-scope measurement against a live `POST /sentinel/verify`.
Nightly GitHub Action (plus `workflow_dispatch`; also on PRs that touch the
suite or engine).

```bash
SENTINEL_API_KEY=… SENTINEL_BASE_URL=https://<preview-or-prod> \
  npm run suite:action-auth
```

**First-ship baseline:** `false_ALLOW` must be **0** (job fails otherwise).
`false_BLOCK` is printed with scenario ids and receipt ids but does **not**
fail the job until structured mandate ([#51](https://github.com/ThoughtProof/thoughtproof-sentinel/issues/51))
tightens the ADR-0019 dual threshold. After prompt-only [#57](https://github.com/ThoughtProof/thoughtproof-sentinel/pull/57),
`ok-01` / `ok-02` / `ok-03` may still be cascade false_BLOCK — the runner
reports them honestly (no quarantine).

**GitHub secrets / variables** (see comments in
`.github/workflows/action-authorization-suite.yml`):

| Name | Required | Purpose |
| --- | --- | --- |
| `SENTINEL_API_KEY` | yes (cron / dispatch) | `X-Sentinel-Key` |
| `SENTINEL_BASE_URL` | recommended | Preview or prod origin (no hardcoded default in CI) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | if Preview is protection-gated | `x-vercel-protection-bypass` |
