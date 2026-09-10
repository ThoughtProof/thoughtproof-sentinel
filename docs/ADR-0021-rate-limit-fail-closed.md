# ADR-0021: Sentinel rate-limit fail-closed on Redis failure

**Status:** Accepted (2026-09-10)  
**Issue:** #41  
**Decider:** Founder product default (fail-closed), implemented in code

## Context

Upstash Redis backs:

- authenticated + global rate limits (`src/auth.ts`)
- x402 payment-intent storage (`src/middleware/x402.ts`, payment-intents confirm)
- ADR-0020 A1 shadow sink (intentionally fail-open)

On 2026-09-10 production runtime logged:

```text
[Upstash Redis] The redis token contains whitespace or newline, which can cause errors!
```

Root cause: `UPSTASH_REDIS_REST_TOKEN` Production env had a **trailing newline** from an earlier copy-paste into Vercel. The token still PING'd after `trim()`, but the SDK warned on every cold path.

## Decision

1. **Env hygiene:** Production token re-set without trailing whitespace; redeploy required for env to bind.
2. **Client init:** Always `trim()` URL + token. If trim changes the value, log a clear one-shot config warning (no secret). Invalid-after-trim → not "configured".
3. **Rate limit when Redis is configured but unavailable:** **fail closed**.
   - HTTP **503** `RATE_LIMIT_UNAVAILABLE`
   - `Retry-After: 30`
   - Evaluated **before** the x402 payment gate (same ordering as `MODEL_CONFIG_MISSING`) so a down limiter cannot bill or settle.
4. **Rate limit when Redis env is unset:** keep existing **in-memory** per-instance fallback (dev / misconfig without paid exposure assumption). This is *not* the production path.
5. **Shadow sink:** remains fail-open (observability must not block verify). It still trims credentials via the shared helper.
6. **Payment intents:** still require Redis; unavailable storage stays non-2xx (existing behaviour), now with trimmed credentials.

## Consequences

- Paid / high-volume agents (`v3api`, `grokbot`) will see 503 instead of unbounded throughput if Upstash blips.
- Operators must keep `UPSTASH_REDIS_REST_*` clean; prefer `printf '%s' | vercel env add` over dashboard paste.
- Active limiter check (burst N calls / window against a **test** key) remains an operator script — not automated against production keys in CI.

## Non-goals

- Rotating the Upstash token solely for whitespace (trim + re-set of same secret is enough when PING works).
- Changing per-key numeric limits (still 120/min auth, 30/min global default).
