# ThoughtProof Sentinel

Agentic verification API — lightweight verification for autonomous agent workflows.

## Endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/sentinel/health` | GET | Liveness (`ok`) + readiness (`ready`, `serv_key`, `rate_limit`). `rate_limit: "redis"` means Upstash env is configured, not connectivity-checked. |
| `/sentinel/tiers` | GET | Tier discovery |
| `/sentinel/verify` | POST | Verification; optional `signed_export` when export key env is set (M1) |
| `/.well-known/thoughtproof-keys.json` | GET | Ed25519 pubs for M1 signed canonical export (pin URL + kid OOB) |
| `/.well-known/validation-keys.json` | GET | Public keys for ERC-8004-style validation artifacts |
| `/openapi.json` | GET | Live OpenAPI 3.1 document |
| `/docs` | GET | Swagger UI over `/openapi.json` |
| `/redoc` | GET | ReDoc over `/openapi.json` |

## Diagnostics (unsigned)

Kind diagnostics in `meta.promotion` (declared, prose-derived and effective kinds,
plus the rejecting-rule metadata) are **not covered by the M1 signature or canonical
hash**. Verifying `signed_export` authenticates its canonical payload, not these
mutable diagnostic fields. Do not use them as tamper-proof evidence or signed
authorization. Legacy receipts without the new fields continue to verify unchanged.
See the [diagnostic trust boundary and compatibility tests](docs/issue-85-mcp-documentation-fix.md#diagnostics-unsigned).

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
`POST https://sentinel.thoughtproof.ai/sentinel/verify` (~20–25¢/night at
`standard`, 27 × $0.008). Nightly GitHub Action (plus `workflow_dispatch`;
also on PRs that touch the suite or engine). Preview is an optional
override for PR/dispatch only.

```bash
SENTINEL_NIGHTLY_API_KEY=… npm run suite:action-auth
# Preview override (PR / dispatch only):
SENTINEL_NIGHTLY_API_KEY=… SENTINEL_BASE_URL=https://<preview> npm run suite:action-auth
```

Use a **dedicated** Sentinel API key (secret `SENTINEL_NIGHTLY_API_KEY`).
Every request sets `X-Sentinel-Agent-Id: nightly-suite` (billing `agent_id`
and verify-log `agent=`) plus `agent_context.agent_id` so the 27 nightly
receipts can be filtered from organic traffic.

**First-ship baseline:** `false_ALLOW` must be **0**. `false_BLOCK` is a
**ratchet**: the job fails if the count exceeds named `FALSE_BLOCK_BASELINE = 0`
(first-ship occupants were ok-01 / ok-02 / ok-03 / ok-06; all ALLOW’d
across three green suite nights). Changing that constant requires a
CHANGELOG line. Suite-format ok-01/02/03 false_BLOCKs were a
**format artifact** (quote recovery only saw MCP
labels; [#66](https://github.com/ThoughtProof/thoughtproof-sentinel/issues/66)
Track 1b + drain MCP probe). After ≥3 green nights and founder GO the
ceiling is **0** (shipped [#73](https://github.com/ThoughtProof/thoughtproof-sentinel/pull/73)).
Count the **suite** job, not the whole workflow:

- Night-1 `workflow_dispatch` [34679110882](https://github.com/ThoughtProof/thoughtproof-sentinel/actions/runs/34679110882) (2026-09-12): Live suite `false_ALLOW=0 false_BLOCK=0 known_false_block=2 ok=24/26 PASS` (then-baseline 4)
- Night-2 `schedule` [34751435696](https://github.com/ThoughtProof/thoughtproof-sentinel/actions/runs/34751435696) (2026-09-13): Live suite `false_ALLOW=0 false_BLOCK=0 known_false_block=2 ok=24/26 PASS`; SRI job success
- Night-3 `schedule` [34834139083](https://github.com/ThoughtProof/thoughtproof-sentinel/actions/runs/34834139083) (2026-09-14): Live suite `false_ALLOW=0 false_BLOCK=0 known_false_block=2 ok=24/26 PASS`; SRI job success
- Night-4 `schedule` [34955914579](https://github.com/ThoughtProof/thoughtproof-sentinel/actions/runs/34955914579) (2026-09-15, tip `d168a17`): last 26-scenario green night — Live suite `false_ALLOW=0 false_BLOCK=0 known_false_block=2 errors=0 ok=24/26 PASS`; SRI job success. Post-[#76](https://github.com/ThoughtProof/thoughtproof-sentinel/pull/76) / pre-conversion nights: **27** scenarios, then-expect `known_false_block=3`. First clean `kfb-03` observation is the night AFTER that merge; `sent_62d3e975` stays provisional (budget contamination).
- Night-5 `schedule` [35082208313](https://github.com/ThoughtProof/thoughtproof-sentinel/actions/runs/35082208313) (2026-09-16, tip `b1ff8ea`): Live suite `false_ALLOW=0 false_BLOCK=0 known_false_block=2 errors=0` Gate PASS. Former `kfb-03` ALLOW-drift (`verdict=ALLOW` `class=ok` `sent_7bdb44965cef4821`) after [#80](https://github.com/ThoughtProof/thoughtproof-sentinel/pull/80). Converted to `ok-07-deploy-ship-ops-merge-gate` (`expect: allow`). Post-conversion expect `known_false_block=2` (`kfb-01` / `kfb-02` only).

([#51](https://github.com/ThoughtProof/thoughtproof-sentinel/issues/51)
is closed.) Nightly measurement is the **prose path with MCP-shaped
evidence** (fixtures: `id` / `expect` / `claim` / `evidence`;
`buildVerifyBody` injects no `mandate.kind` / `action.kind`).
Caller-kinds remain unit-test only until thoughtproof-mcp 0.4.0.
Counts are reported honestly (no quarantine).
`known_false_block` is a third, **informational** nightly metric (issue
[#64](https://github.com/ThoughtProof/thoughtproof-sentinel/issues/64)).
As of the 2026-09-22 classifier fix, the suite file has no
`known_false_block` fixtures: `kfb-01` / `kfb-02` are `expect: allow`.
The metric itself remains (overdue WARN does not fail the gate).
Former `kfb-03` (ops merge-gate, refs
[#75](https://github.com/ThoughtProof/thoughtproof-sentinel/issues/75))
is now `ok-07-deploy-ship-ops-merge-gate` (`expect: allow`) after Night-5
ALLOW and [#80](https://github.com/ThoughtProof/thoughtproof-sentinel/pull/80).
Flagged scenarios are counted and printed; they do **not** enter the false_BLOCK
gate. Do not raise `FALSE_BLOCK_BASELINE` to hide them. Each flagged
scenario MUST carry `since` (`YYYY-MM-DD`). After **seven nights** from
`since`, Ship/founder decide: fix the classifier **or** document as a
product limitation with rationale — no open-ended observation. Nightly
prints a WARN when age > 7 (`known_false_block overdue: …`); that WARN
does not fail the gate.
Engine degradation (`promotion=engine_budget_exhausted` / `degradedMode`)
counts as **`errors`**, not `false_BLOCK`
([#77](https://github.com/ThoughtProof/thoughtproof-sentinel/issues/77)).
`false_ALLOW` is never swallowed by the degraded→errors remap.
The gate still fails when `errors > 0` (`errors=N engine_degraded`) —
the night is not evaluable, not a classifier regression. Mirror of the
CDN rule: CDN noise must not void a valid measurement night; engine
degradation must not pretend quality got worse.

**GitHub secrets / variables** (see comments in
`.github/workflows/action-authorization-suite.yml`):

| Name | Required | Purpose |
| --- | --- | --- |
| `SENTINEL_NIGHTLY_API_KEY` | yes (cron / dispatch) | dedicated `X-Sentinel-Key` |
| `SENTINEL_API_KEY` | fallback | same header if the nightly-named secret is unset |
| `SENTINEL_BASE_URL` | no (prod default) | Preview override for PR/dispatch only |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | only if hitting protected Preview | `x-vercel-protection-bypass` |
