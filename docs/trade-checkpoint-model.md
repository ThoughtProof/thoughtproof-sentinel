# Deployment-selected trade checkpoint evaluator

`SENTINEL_TRADE_CHECKPOINT_MODEL=serv-pro` selects Pro alone for requests with
`mode: trade_execution` and `tier: checkpoint`. Supported values are `serv-nano`,
`serv-swift`, `serv-pro`, `openserv/gpt-6-sol` and `openserv/gpt-6-astra`;
absence retains the default Nano checkpoint.
This is deployment configuration, not a caller-provided request field.

The standard/pro tiers retain their existing cascades beginning with Nano.
Using the pro tier therefore does not isolate a different primary evaluator.
The public tier catalog still describes the default configuration; response
`meta.models_used` and verifier stages identify the alias actually used.
Existing advertised tier accuracy/latency figures do not qualify this override.

An invalid setting fails before a provider call. Provider errors, invalid
assessments and restrictive verdicts do not trigger a fallback to Nano or a
repair retry. Source references, prompts, rubric, score floors, risk constraints,
engine deadlines and client deadlines remain unchanged. The provider alias
does not independently attest the backing model identity or its capability.

Local native-engine tests assert byte-identical outgoing evaluator requests
apart from `model`, selected-alias trace reporting, retained negative/invalid
outcomes, no fallback on failure, and unchanged other modes and tier cascades.
Live comparison must use frozen inputs and separate controls from historical
cases. A larger model name or more ALLOW verdicts alone is not qualification.
Configure a preview first; no production default is changed by this patch.

The subsequent [trade risk gate and task profile](trade-risk-gate.md) are separate
changes. The three legacy SERV aliases still change only the selected alias.

## Named OpenServ models

The `openserv/` namespace routes an exact catalog ID through
`https://inference-api.openserv.ai/v1` (or the configured `SERV_BASE_URL`) and
`SERV_API_KEY`. It does not use a direct OpenAI endpoint or its credentials.
Only the two enumerated IDs above are accepted, including in the vendor router.
Astra is catalog-listed and covered by offline routing tests, not live-qualified.

For these routes, `SENTINEL_TRADE_CHECKPOINT_REASONING_EFFORT` accepts `low`,
`medium`, or `high`; absence means `low`. The wire field is `reasoning_effort`.
Explicit invalid values fail before inference. Configuring it on a legacy alias
also fails rather than silently ignoring it. Other modes/tiers ignore both trade
settings. Named routes omit temperature and seed, use `max_completion_tokens`,
require the exact returned model ID and `finish_reason: stop`, and consume only
the final message content. Missing identity or incomplete output fails closed.

On 2026-10-18, an authenticated compatibility check observed:

- `gpt-6.1-sol`: HTTP 400, no pricing configured; absent from the current catalog.
  This is not silently substituted with `gpt-6-sol`.
- `gpt-6-sol` with the old `temperature: 0`: HTTP 400, unsupported temperature.
- `gpt-6-sol`, low effort, provider sampling defaults: HTTP 200, exact model ID
  and a correct final JSON answer to a small arithmetic/boundary check.

OpenServ documents BRAID processing as the default. Our adapter never sends
`x-openserv-disable-braid: true`; no extra invented `braid` request field is used.
Model reasoning effort and BRAID are distinct controls. Default routing is
supported by the documented contract, not independent inspection of provider
internals. The returned model string likewise acknowledges a route, not weights.

Sources: [model catalog](https://docs.openserv.ai/serv-reasoning/models),
[raw versus SERV](https://docs.openserv.ai/serv-reasoning/tutorials/compare-raw-and-serv),
[reasoning effort](https://docs.openserv.ai/serv-reasoning/tutorials/reasoning-effort).
These named routes require separate latency and decision-quality qualification;
the small compatibility check is not that qualification.
