# ADR: Settlement freshness lives at the execution edge
**Status:** Accepted (spec) · 2026-07-30  
**Companion:** [ADR-FRESHNESS-VS-VERIFIER-LATENCY-2026-07-30.md](./ADR-FRESHNESS-VS-VERIFIER-LATENCY-2026-07-30.md)

## Problem

A second freshness check **only inside ThoughtProof** still leaves TOCTOU:

```
T+0    ThoughtProof settlement recheck → PASS
T+5s   queue / network
T+20s  wallet UI
T+45s  user confirms
T+60s  broadcast
```

Any delay after our check re-opens the gap. The **last deterministic stop** must sit where the transaction can still be blocked — wallet policy, authz (e.g. Veridex-class), GOAT/Kyra execution adapter — not only in our API.

## Decision

**Split ownership:**

| Layer | Job |
|---|---|
| **ThoughtProof** | Did the agent build this decision on fresh-enough evidence? Semantic + mandate integrity. Emit **ALLOW + machine-readable execution_conditions**. |
| **Execution guard** | Immediately before sign/broadcast: quote still within settlement TTL, action unchanged, receipt valid. **Fail-closed.** |
| **Wallet** | Signs only if guard passed |
| **Settlement** | Broadcast / settle |

ThoughtProof **owns the specification** of conditions.  
ThoughtProof does **not** have to own every runtime enforcement point.

```
ThoughtProof ALLOW + execution_conditions
        ↓
Execution layer re-checks conditions  ──FAIL→ DENY_EXECUTION → requote → new package → re-verify
        ↓ PASS
Wallet may sign
```

## What ThoughtProof still does internally

1. **Fast deterministic pre-check** (ms):  
   `decision_created_at - quote_observed_at ≤ quote_max_age_at_decision_ms`  
   before expensive cascade.

2. On **ALLOW**, return bindable conditions, e.g.:

```json
{
  "verdict": "ALLOW",
  "execution_conditions": {
    "quote_id": "quote_123",
    "quote_observed_at": "2026-07-30T20:00:00Z",
    "quote_max_age_at_settlement_ms": 180000,
    "action_hash": "0x…",
    "decision_package_hash": "0x…",
    "verification_id": "sent_…",
    "fail_action": "REQUOTE_AND_REVERIFY"
  }
}
```

Meaning: *this allow is only for this action hash, only while this quote remains inside settlement TTL.*

## What the third party / edge must do

Immediately before sign/broadcast:

- `now - quote_observed_at ≤ quote_max_age_at_settlement_ms`
- `action_hash` matches the hash ThoughtProof evaluated
- quote / calldata / minOut not mutated off-package
- router, amount, slippage, recipient still within spend policy
- ThoughtProof artifact / signature valid (public key via well-known)

On failure: **DENY_EXECUTION** → new quote → new decision package → new ThoughtProof verify.  
Do not “patch” quote onto an old allowed package.

## Implementation options (all valid)

| Option | When |
|---|---|
| **A. Veridex / wallet policy** | If it can bind authenticated custom fields (quote time, action_hash) and fail-closed on sign path. **Not assumed today** — do not claim Veridex already does this until proven. |
| **B. Partner adapter (Kyra Swap Lane, GOAT AgentKit hook)** | Natural place where txs are prepared for approval. |
| **C. Reference `tp-execution-guard`** | Small wallet-agnostic library: verify receipt sig → compare action hash → settlement TTL → invoke configured wallet **only on PASS**. No key custody, no tx construction — pass-through or stop only. |

Product stance: ship **C as reference/fallback**; map same contract onto A/B when partners integrate.

## Product boundary (one line)

> ThoughtProof decides under which **checkable conditions** an action is justified.  
> The component **at the wallet** enforces that those conditions still hold at sign time.

Complements Veridex-class authz; does not replace spend limits or key policy.

## Non-goals

- Claiming Veridex natively enforces our settlement TTL today  
- TP holding keys or building calldata in the guard  
- Replacing partner execution stacks with a mandatory TP-only wallet  

## Related

- Freshness ADR: decision-time vs settlement TTL vs VERIFY_TIMEOUT  
- Boundary demos: representative authz ALLOW + TP OBJECT (decision lane)  
- Signed validation artifacts + `/.well-known/validation-keys.json`  
