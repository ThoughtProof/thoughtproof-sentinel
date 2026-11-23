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
| `fix1_strict_recorded` | arm (c) strict-format text. Tolerant parse (`reason` → `reasoning`, predicate from score). The recorded second attempt is used only when the first is still malformed. Still malformed → `ERROR`, not ALLOW. Well-formed nano still cascades, so a HOLD can become BLOCK when swift said BLOCK. |
| `fix1_plus_fix3` | same, then step_0 is not applicable when the decision cites no numerical threshold. |
| `fix1_plus_fix3_swift_fallback` | same, and a nano item that is still malformed uses the recorded swift item. A permissive swift verdict is clamped to HOLD, which maps to UNCERTAIN. |
| `alias_only_on_raw_nano` | arm (a) with the alias only, no strict-format text. Missing quotes still take PROV_FAIL_01. |

Grok-4.3 is a separate solo table (`current_main`, `fix1`, `fix1_plus_fix3`). Fix 1 does not change it: the captured steps already have `reasoning`, `quote`, and `predicate`. This repo does not call xAI and does not route grok in the cascade.

The Nov 23 table is `current` (the recorded public verdict) and `fix3` (step_0 adjusted on the post-processed steps, then `deriveVerdict`). Fix 1 and the swift fallback are not re-scored there: the file has no raw model JSON and no swift text for the 974 nano-only calls.

`replay_matches_recorded_block_or_not` is how often re-deriving the post-processed predicates matches the recorded public verdict before the step_0 change. It is not 996/996; the step scores were already capped, and a few swift rows do not round-trip.
