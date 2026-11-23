# trade_execution step quality

`mode=trade_execution` writes one JSON line per verification:

```json
{"event":"sentinel.trade_execution.step_quality","surfaced_model":"serv-nano","primary_model":"serv-nano","cascade_reason":"primary_block","steps":3,"templated_reasoning_steps":3,"null_or_absent_quotes":3,"malformed_step_fallback":false,"primary_block":true}
```

The line carries counts only. It does not include the claim, the evidence, quotes, or reasoning text.

Same-process rolling shares (window 100) warn on `sentinel.trade_execution.step_quality_alert` when a share stays at or above the threshold for at least 20 samples:

| metric | threshold | what it counts |
|---|---|---|
| `templated_reasoning_share` | 0.80 of steps | Sentinel synthesized the objection because the model left reasoning empty |
| `null_quote_share` | 0.80 of steps | model quote null or absent, before mandate recovery |
| `malformed_fallback_share` | 0.50 of requests | primary threw the malformed-nano error and the secondary ran |
| `primary_block_share` | 0.90 of requests | cascade reason exactly `primary_block` |

A log drain should aggregate the per-request lines. Example over a newline-delimited export (no suite run, no model call):

```bash
jq -s '
  [.[] | select(.event=="sentinel.trade_execution.step_quality")]
  | group_by(.primary_model)
  | map({
      model: .[0].primary_model,
      n: length,
      primary_block_share: (map(select(.primary_block)) | length) / length,
      malformed_fallback_share: (map(select(.malformed_step_fallback)) | length) / length,
      templated_reasoning_share: (map(.templated_reasoning_steps) | add) / (map(.steps) | add),
      null_quote_share: (map(.null_or_absent_quotes) | add) / (map(.steps) | add)
    })
' drain.jsonl
```

Alert when `primary_block_share >= 0.90` or `null_quote_share >= 0.80`. Both were ~1.0 on the 23 Nov 2026 CB4A replay and ~0.13 / low in the June–July window.
