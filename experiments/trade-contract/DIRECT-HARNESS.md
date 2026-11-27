# Direct comparison harness

Offline only. The Sentinel candidate is frozen. This file does not change it. No fresh holdout texts are in this commit.

## Candidate freeze

The candidate is extractor arm B, including the `section_heading` downgrade in `adapter.ts`. `direct-freeze-manifest.json` records the arm B system-prompt sha256 and the sha256 of each file that produces the request, the parser, the adapter, `evaluate.ts`, and the grounding host. `direct-harness.test.ts` fails if any of those hashes drift.

Arm B request, verified from `model-config.ts` and `comparison-run.ts` `buildArmRequest`: model `grok-4.7`, temperature 0, seed 42, `reasoning_effort` `low`, `max_completion_tokens` 4096. The request object has no `tools` field. The system text is `armSystemPrompt('B')`. The wire schema is `comparison-schema.ts`.

`evaluate.ts` bytes equal the file at `30777b0`. `adapter.ts` does not: its last change is `b3ae9de`. The downgrade that rejects `section_heading` is still in the current adapter. v3-05 B remains a documented error of this candidate.

## Reference provenance

Label: **historical critic + gateway**.

Source: local working copy, tarball sha256 `74206af0ccb1ec13c7c2199e103c3c182472039f0b8655fecab666f60e0eb290`. The folder was untracked in the thoughtproof-mcp checkout at local HEAD `4214afc24f55b735f44235029bc1ba658552eb04`. It is not in that commit. Provenance is the tarball hash, not a commit.

| Evidence | Where |
| --- | --- |
| System prompt | `critic_live.py` `CRITIC_SYS`. Sha256 `a5d64c411bea393183e8b6533105f33ea81c5fe6b165db4850a9a0f7b52d2b7a`. Copied into `direct-historical.ts`. |
| Model | Default `grok-4-fast-reasoning` (`critic_live.py`, `CRITIC_MODEL`). `efficacy-heldout-v1.json` field `critic_model` is that id. Rows that called the model store `critic.model` `grok-4-fast-reasoning`. |
| Temperature 0.2, no seed, no tools, HTTP timeout 90s | `critic_live.py` request body. Not present in the result JSON. |
| Gateway rules | `runner.py` `gateway_strong`. Ported in `direct-historical.ts`. |
| Binding | `critic_live.py`: gateway first; a block skips the model and adds `critic_live_skipped_gateway_block`; execute is critic and gateway. Result rows match: gateway blocks have `critic.skipped` true and `critic.model` null (`qty_over_cap`, `sequence_missing`, `evidence_sku_mismatch`, `evidence_stale`). Gateway passes then the critic decides (`gateway_strong_all_structured_checks_ok` or `draft_hold_ok`, model set). |
| Runner | `efficacy_run.py` calls `gateway_strong` and `critic_live`. The JSON `archive_dir` basename `efficacy-inputs-20260925T213716Z` is in the tarball. |
| Sent/resp bodies | Those files are `tp_live` packets (`mode` `dql`, mandate text). They do not contain the critic model id or `CRITIC_SYS`. The critic HTTP body was not archived. |

Open: the model id in the JSON is what the runner wrote, not a captured wire body. Temperature and the 90s timeout are source-only. The gateway checks SKU, quantity, evidence, and draft/commit fields. It has no Helio trade-order rule. A trade-order case without that `world` is `gateway_input_incomplete` and does not execute. The original Python would raise; this harness maps that to `INFRA_ERROR`, which is also not an ALLOW. The six fresh trade-order cases are not written here. Until an independent author supplies cases this gateway can read, this arm cannot ALLOW a Helio order.

`abstraction-exp-v2/lib/critic.mjs` was not used as the reference. The September prompt and gateway rules are present, and the held-out rows trace to `critic_live`. That file remains a different system: one `gpt-6.1-sol` Responses call, reasoning high, quote check that can only reject an ALLOW, called from `run.mjs`.

The Sentinel cascade (`runSentinelCascade`, `mapVerdict`, `runAuthorizationGate` default `shadow`) is a separate comparison. It is not this counter-arm.

## Budget

45 seconds per system and per case, through the binding decision, including gateway and any critic call. The executor is `simulatedExecution`. It is the same function for both arms. It executes only when the system verdict is ALLOW, the duration is within 45 seconds, and every call is `completed` or `not_sent`.

Sentinel arm B, from the frozen files and the v3 archive:

| Item | Value |
| --- | --- |
| Calls that the archive sent | 6 primary `grok-4.7`, one per case, arm B only. Parser accepted all 6, so the block-only secondary `grok-4.3` was not sent. |
| Escalation that the candidate can still make | One `grok-4.3` call if the primary is timeout, transport error, HTTP error, empty, parse error, schema violation, or missing checks (`model-config.ts` `cascade.when`). Not used on this archive. |
| Measured cost | Arm B usage ticks / 10^10 = 0.184452 USD. Price source: the `cost_in_usd_ticks` field on the stored responses (1 USD = 10^10 ticks). |
| Card rates | `model-config.ts`, doc `https://docs.x.ai/docs/models`, retrieved 2026-11-24. `grok-4.7` short context input 2 / output 6 USD per 1M. `grok-4.3` short context input 1.25 / output 2.5. `maxCallCostUsd` is an estimate, not this measured bill. |
| Helio control | Replay of `fixtures/orddev-v3-20261127` arm B. Only v3-01 executes. v3-03 is ALLOW at 47366 ms and does not execute. v3-05 is UNCERTAIN and does not execute. |

Historical arm:

| Item | Value |
| --- | --- |
| Calls | 0 when the gateway does not execute. Otherwise one `grok-4-fast-reasoning` call. No second stage. |
| Temperature | 0.2 in the source. No seed. No tools. |
| Wall | This harness stops at 45s. The September client timeout was 90s. A reply after 45s is a late ALLOW and does not execute. |
| Price | Unknown. `model-config.ts` does not price `grok-4-fast-reasoning`. The September JSON has `cost_in_usd_ticks` on a different suite. That is not a price for a Helio call. |

No stored critic answer exists for the Helio cases. The Helio control runs the Sentinel replay only. The historical arm is covered by mocks.
