# agent_context — declared acting-agent metadata (2026-07-29)

Optional request field on `POST /sentinel/verify` for the **Intuition / ERC-8004 pilot**.

## Why

Sentinel judges **this action**. For graph contribution and integrity reports we also need stable labels about **who** acted and **which model** they declared — without guessing and without turning verdicts into reputation scores.

## Contract

| | |
|---|---|
| Required for verify? | **No** — omit anytime |
| Affects verdict? | **No** — echo only |
| Inferred? | **Never** — caller declares or field stays empty |
| Canonical verdict hash? | **Not included** |

### Hash / signature boundary (explicit)

> `meta.agent_context` is **echoed metadata** and is **not** covered by the canonical verdict signature/hash (`sentinel.verdict.canonical.v1`).  
> A receipt does **not** prove which agent model produced the decision — only that the caller *declared* those labels alongside the check.  
> Future: optional `context_hash` on a v2 receipt or a separately signed context attachment. Do **not** silently expand the existing hash.

### Request (pilot shape)

```json
{
  "claim": "...",
  "evidence": "...",
  "mode": "trade_execution",
  "agent_context": {
    "agent_id": "tp-pilot-1",
    "erc8004": { "chainId": 8453, "tokenId": 37477 },
    "identity_source": "operator_declared",
    "identity_verified": false,
    "agent_model": "xai/grok-4",
    "agent_model_provider": "xai",
    "agent_model_source": "operator_declared",
    "agent_model_role": "action_generator",
    "agent_runtime": "cb4a",
    "external_request_id": "cycle-1721",
    "environment": "paper",
    "tags": ["intuition-pilot"]
  }
}
```

Defaults when omitted but parent field present:
- `agent_model` → `agent_model_source=operator_declared`, `agent_model_role=action_generator`
- `agent_id` / `erc8004` → `identity_source=operator_declared`, `identity_verified=false`
- `identity_verified=true` rejected unless `identity_source` is `erc8004_registry` or `api_key_binding`
- `request_id` accepted as alias → normalized to `external_request_id`

### Response

```json
{
  "id": "sent_…",
  "verdict": "ALLOW",
  "meta": {
    "models_used": ["serv-nano", "serv-swift"],
    "agent_context": { "…echo with defaults…" }
  }
}
```

| Field | Meaning |
|---|---|
| `meta.models_used` | **Verifier** cascade |
| `meta.agent_context.agent_model` | **Acting** agent model (**declared**) |

## cb4a env pass-through

| Env | Maps to |
|---|---|
| `CB4A_AGENT_ID` | agent_id |
| `CB4A_AGENT_MODEL` | agent_model |
| `CB4A_AGENT_MODEL_PROVIDER` | agent_model_provider |
| `CB4A_AGENT_RUNTIME` | agent_runtime |
| `CB4A_AGENT_ENV` | environment |
| `CB4A_SKILL_VERSION` | skill_version |
| `CB4A_ERC8004` | JSON `{ "chainId", "tokenId" }` |

Only set `CB4A_AGENT_MODEL` to the model that **actually** generates the thesis/action.

## Ready criteria (before 8004 chat)

- [x] Prod accepts `agent_context`
- [x] Prod echoes it (with source defaults)
- [x] Existing clients + canonical hashes unchanged
- [x] Real paper path E2E (cb4a verify-client → prod) carries declared agent + ERC-8004 metadata — see agent-context-paper-e2e-proof-2026-07-29.json
- [x] Docs state: declared, not verified, not signed into verdict

## Privacy

No secrets, full prompts, or PII in `agent_context`. Short ids and model labels only.
