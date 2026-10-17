# Cycle Engine quote regression fixtures

These three requests are unchanged copies of the explicitly synthetic controls
sent on 17 October 2026. They contain no credentials or current/historical market
observations. The positive control returned UNCERTAIN with three absent quotes;
the risk contradiction and missing-evidence controls returned BLOCK.

The regression tests replace only HTTP completions. Their controlled model replies
are synthetic and exercise the installed router, parser, provenance checks and
native Sentinel engine. Passing them is not live model qualification, proof of
profitability, or a false-positive-rate measurement. No request is sent by the tests.
