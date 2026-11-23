# CB4A trade_execution offline re-score

```bash
npm run rescore:cb4a
```

No OpenServ, xAI, OpenAI, or Sentinel call. The script reads `test/fixtures/cb4a-rescore/` and prints verdict counts.

`paid.json` is the 23 Nov 2026 capture: 20 cases × 3 draws of serv-nano, serv-swift, strict-format nano, and grok-4.3 raw steps, plus the case claim and evidence. One nano/swift/strict draw (cycle 1113, draw 1) was missing from `results-main.jsonl` and was recovered from that run's HTTP response body. `nov23.json` is the 996-call prod replay after Sentinel post-processing, joined to the decision text and 24h returns. 22 cycles have no return (`fetch failed`); they stay in the verdict totals and drop out of the winner/loser ratios.

Columns on the paid nano rows:

| column | what is re-scored |
|---|---|
| `current_main` | arm (a) raw nano, pot-cli 0.8.13 with the nano contract off, cascade with the recorded swift item. `CONFIRM_BLOCKS` is not enabled. |
| `fix1_strict_recorded` | arm (c) strict-format text. Tolerant field names, strict shape: expected step ids once each, scores finite and in [0, 1]. The recorded second attempt is used only when the first is malformed. Still malformed → `ERROR`, not ALLOW. |
| `fix1_swift_fallback` | same, and a still-malformed nano item uses the recorded swift item. A permissive swift verdict is clamped to HOLD, which maps to UNCERTAIN. |
| `alias_only_on_raw_nano` | arm (a) with the alias and the strict shape check, no strict-format text. Missing quotes still take PROV_FAIL_01. |

Grok-4.3 is a solo table (`current_main`, `fix1`). Fix 1 does not change it. This branch does not apply the step_0 rule. The Nov 23 table is the recorded public verdict only.

`replay_matches_recorded_block_or_not` is how often re-deriving the post-processed predicates matches the recorded public verdict before the step_0 change. It is not 996/996; the step scores were already capped, and a few swift rows do not round-trip.
