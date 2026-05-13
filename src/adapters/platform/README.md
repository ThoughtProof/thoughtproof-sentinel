# Platform Adapters

Authentication and lifecycle layer for Sentinel. See [ADR-0017](../../docs/ADR-0017-payment-adapter-layer.md).

## Architecture

Platform adapters handle WHO calls Sentinel — auth, webhook signatures, and platform-specific lifecycle.

```
Route → Platform Adapter (auth) → Engine (verify) → Payment Adapter (bill)
```

## Adapters

| Adapter | Status | Use Case |
|---------|--------|----------|
| `openserv.ts` | Planned | X-Sentinel-Key auth, webhook signatures |
| `acp.ts` | Planned | Virtuals ACP job lifecycle |

## Implementation Priority

1. **OpenServ** — Phase 1 (post-AMA, API key auth)
2. **ACP** — when Virtuals integration is concrete

Phase 0 (AMA demo) uses no platform adapter — open auth.
