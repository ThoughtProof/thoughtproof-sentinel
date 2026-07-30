# ThoughtProof Sentinel — design notes

| Doc | Topic |
|---|---|
| [ADR-FRESHNESS-VS-VERIFIER-LATENCY-2026-07-30.md](./ADR-FRESHNESS-VS-VERIFIER-LATENCY-2026-07-30.md) | Quote freshness ≠ verifier latency; settlement TTL; taxonomy codes |
| [FAILURE-TAXONOMY-v0-2026-07-30.md](./FAILURE-TAXONOMY-v0-2026-07-30.md) | Reporting-only failure codes + windowed rates |
| [ERC8004-VALIDATION-RECEIPT-v0-2026-07-30.md](./ERC8004-VALIDATION-RECEIPT-v0-2026-07-30.md) | Validation-shaped artifact schema |
| [VERIDEX-VS-TP-BOUNDARY-2026-07-30.md](./VERIDEX-VS-TP-BOUNDARY-2026-07-30.md) | Deterministic authz vs decision validation |
| [agent-context-2026-07-29.md](./agent-context-2026-07-29.md) | Optional `agent_context` on verify |

Public keys: `https://sentinel.thoughtproof.ai/.well-known/validation-keys.json`  
Portable verify: `scripts/verify-validation-artifact.mjs`
