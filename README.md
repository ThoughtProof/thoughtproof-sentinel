# ThoughtProof Sentinel

Agentic verification API — multi-model decision checks **before settlement**.

Catches failures deterministic policy gates systematically miss (mandate/scope/intent/stale thesis). Deterministic rules at the edge are defense-in-depth, not the product identity. Org SoT: `ThoughtProof/docs/ARCHITECTURE-POSITION-v0.1.md`.

## Live

- **Base:** https://sentinel.thoughtproof.ai  
- **Health:** `GET /sentinel/health`  
- **Tiers:** `GET /sentinel/tiers`  
- **Verify:** `POST /sentinel/verify` (auth: `X-Sentinel-Key` or x402 — unauthenticated → **402**)  
- **L1 sign (opt-in):** header `X-Sentinel-Issue: sign` on verify, or `POST /sentinel/attest`  
- **Keys:** `GET /.well-known/validation-keys.json`

## Endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/sentinel/health` | GET | Health check |
| `/sentinel/tiers` | GET | Public tier discovery (pricing + calibration metadata) |
| `/sentinel/verify` | POST | Decision verification (live) |
| `/sentinel/attest` | POST | Issue L1 Ed25519 attestation for a cached verificationId |

## Public tiers (customer-facing)

| Tier | Price | Cascade | Notes |
|------|-------|---------|-------|
| checkpoint | **$0.005** | serv-nano solo | High-volume, individually lower-stakes |
| standard (default) | **$0.008** | serv-nano → serv-swift | Default production tier |

**Accuracy / false-ALLOW figures** on `/sentinel/tiers` include **denominators and suite labels**. Do not cite bare rates without `n`.

**Latency (honest):** cascade wall-clock is typically **seconds to tens of seconds** under load (internal band often ~5–45s depending on tier, provider, and mode) — not sub-second marketing. Verifier latency is an infrastructure/SLO outcome; it must not be folded into agent “mandate violation” scores (see `docs/ADR-FRESHNESS-VS-VERIFIER-LATENCY-2026-07-30.md`).

## Modes

- `handoff` — Inter-agent claim-packet verification  
- `plan_revision` — Goal-drift detection at checkpoints  
- `memory_write` — Self-summary faithfulness  
- `output_synthesis` — Final report quality guard  
- `trade_execution` / `trade_reasoning` — Trading decision checks  
- `action_authorization` — Mandate-bound action gate (+ optional deterministic edge checks)

## L1 signed verdicts

Opt-in Ed25519 over JCS-canonical body (`sentinel.verdict.canonical.v1`).

Third party:

1. Obtain attestation (`canonicalJson` + `signature`)  
2. `GET /.well-known/validation-keys.json`  
3. Verify Ed25519 over **exact** `canonicalJson` bytes  
4. Check `sha256(canonicalJson) == canonicalHash`

Pilot key — rotate before high-reliance use.

## Development

```bash
npm install
npm test
vercel dev
```
