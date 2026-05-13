# ThoughtProof Sentinel

Agentic verification API — lightweight verification for autonomous agent workflows.

## Endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/sentinel/health` | GET | Health check |
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
