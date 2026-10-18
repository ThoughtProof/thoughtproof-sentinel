# Deployment-selected trade checkpoint evaluator

`SENTINEL_TRADE_CHECKPOINT_MODEL=serv-pro` selects Pro alone for requests with
`mode: trade_execution` and `tier: checkpoint`. Supported values are `serv-nano`,
`serv-swift` and `serv-pro`; absence retains the default Nano checkpoint.
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
