# dev-v2 trade orders

Six sealed Helio orders. Pair mapping and expected verdicts live in `labels.ts`, which the prompt builder does not import.

## Later model run

`--trade-order-dev` selects only `tradeOrderCases()` (`ord-01` through `ord-06`). `--schema-smoke` still uses `casesFor('dev')`, the closed payment cases. `--paid` without `--trade-order-dev` stays the pilot. Combining `--trade-order-dev` with `--schema-smoke` or `--pilot` aborts before a send.

The plan command does not need a key:

```sh
node --experimental-strip-types experiments/trade-contract/comparison-offline.ts --trade-order-dev
```

The paid command reads `XAI_API_KEY` from the environment. The 1 USD cap is soft.

```sh
node --experimental-strip-types experiments/trade-contract/comparison-offline.ts --trade-order-dev --paid
```
