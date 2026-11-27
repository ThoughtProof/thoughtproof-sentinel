# dev-v2 trade orders

Six sealed Helio orders. Pair mapping and expected verdicts live in `labels.ts`, which the prompt builder does not import.

## Later model run

There is no entry point that sends `ord-01` through `ord-06`.

`comparison-smoke.ts` `schemaSmokeDocuments` returns `casesFor('dev')`. That list is the closed payment cases `dev-01` through `dev-06`. `comparison-offline.ts` `--schema-smoke` and `--paid` call that path or the pilot. Neither flag loads this directory.

`tradeOrderCases()` in `cases.ts` is an offline list of these six cases. It is not connected to a paid command.
