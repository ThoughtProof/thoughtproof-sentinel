# trade_execution step quality

`mode=trade_execution` writes one JSON line per verification:

```json
{"event":"sentinel.trade_execution.step_quality","surfaced_model":"serv-swift","primary_model":"serv-nano","step_model":"serv-swift","cascade_reason":"primary_error_fallback","steps":3,"templated_reasoning_steps":1,"null_or_absent_quotes":2,"malformed_step_fallback":true,"primary_block":false}
```

`step_model` is the model whose steps are on the receipt. It is not the last model called. When swift is invoked and errors, the receipt still carries nano's steps and `step_model` is `serv-nano`. A swift success that supplies the receipt steps uses `serv-swift`. When both models fail, the log is `cascade_error: true` with `step_model: null` and `steps: 0`, and neither model's step counters move.

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
  def rows: [.[]
    | select(.event=="sentinel.trade_execution.step_quality"
        and .cascade_error != true
        and .steps > 0)];
  {
    steps: (rows | group_by(.step_model) | map({
      model: .[0].step_model,
      n: length,
      templated_reasoning_share: ((map(.templated_reasoning_steps) | add) / (map(.steps) | add)),
      null_quote_share: ((map(.null_or_absent_quotes) | add) / (map(.steps) | add))
    })),
    primary: (rows | group_by(.primary_model) | map({
      model: .[0].primary_model,
      n: length,
      primary_block_share: ((map(select(.primary_block)) | length) / length),
      malformed_fallback_share: ((map(select(.malformed_step_fallback)) | length) / length)
    }))
  }
' drain.jsonl
```

`cascade_error` rows have `steps: 0`. They are dropped before the division so an all-error batch does not divide by zero, and a null `step_model` is not a model bucket.

Alert when `primary_block_share >= 0.90` or `null_quote_share >= 0.80`. Both were ~1.0 on the 23 Nov 2026 CB4A replay and ~0.13 / low in the June–July window.
