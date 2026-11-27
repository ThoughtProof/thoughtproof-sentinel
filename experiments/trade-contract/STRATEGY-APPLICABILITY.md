# order_strategy_consistency: what #140 requires

Offline reading of `30777b0`. The gate and the comparison prompt were not changed. The three-way host flag below was run only in a local scratch.

## 1. What the check secures

`order_strategy_consistency` is an always-on check that the concrete order matches an evidenced strategy. The contract does not judge that match itself. It requires the adapter to say `fulfilled` or `contradicted`, and it requires an order quote plus an independent source quote.

- `experiments/trade-contract/README.md:12`: "Immer: die konkrete Order passt inhaltlich zur belegten Strategie/Entscheidungsabsicht." Meaning, instrument, and order type are the adapter's judgment, not string equality.
- `experiments/trade-contract/README.md:19`: N/A is only for the three optional checks (`mandate_compliance`, `additional_claims`, `numeric_limits`) when the matching list is empty and the basis is `none_in_complete_scope`. `decision_basis` and `order_strategy_consistency` are not in that set.
- `experiments/trade-contract/evaluate.ts:246`: `mandatory` is exactly those two check ids. The N/A branch at `evaluate.ts:251` requires `!mandatory`.
- `experiments/trade-contract/evaluate.ts:263-265`: this check's requirement ids must be exactly the requirements of kind `strategy`. An empty model list matches only when the adapter extracted no strategy. It does not turn the check off.
- `experiments/trade-contract/evaluate.ts:277`: once the check is applicable, a model status of `not_applicable` or `not_verifiable` stays `not_verifiable`.
- `experiments/trade-contract/evaluate.ts:278-286`: `fulfilled` still needs a proposal quote and a source quote. `contradicted` still needs a proposal quote.
- `experiments/trade-contract/evaluate.ts:102-103`: `contradicted` is BLOCK. `not_verifiable` is UNCERTAIN. `not_applicable` does not block ALLOW. This check never receives that last status from the current function.
- `experiments/trade-contract/prompt.ts:23`: "decision_basis and order_strategy_consistency are mandatory."

The invented case is a share sale, not a payment. `development-fixture.ts:12-19` is "Reduce Helio exposure" plus "Verkaufe 10 der vorhandenen 40 Helio-Aktien mit einer Limitorder." `development-fixture.ts:56-57` marks the strategy check `fulfilled` with the order quote and the strategy quote.

Tests on that claim:

- `contract.test.ts:69-81` expects ALLOW only with `order_strategy_consistency` `fulfilled`.
- `contract.test.ts:84-91` sets `semanticChecks[1].status` to `contradicted` and expects BLOCK. The comment says this transports a supplied judgment. It does not test whether a sell entails a reduce-strategy.
- `contract.test.ts:132-143` drops the source document and expects UNCERTAIN. The order alone cannot fulfill the check.
- `contract.test.ts:221-230` allows N/A for mandate and numeric limits and keeps the strategy requirement.
- `contract.test.ts:233-243` mode `mandatory-na` sets `applicability[0]` (`decision_basis`, the first of `CHECK_IDS`) to `not_applicable` and expects UNCERTAIN. The same `mandatory` flag at `evaluate.ts:246` covers `order_strategy_consistency`. A scratch call on the real gate, with that check's applicability set to `not_applicable` / `none_in_complete_scope` and an empty strategy list, returns UNCERTAIN with `APPLICABILITY_CONFLICT` at `$.applicability[1]`.

#140 does not mention payments, invoices, or bills. Its fixtures are equity orders (Helio, Quill), a strategy sentence, a mandate, and a risk limit. A payment is not given a separate treatment. Under this contract a bundle with no strategy clause cannot honestly release: the check stays mandatory, and a model `not_applicable` or an empty requirement list does not skip it.

## 2. dev-03

No authorized source requires a strategy check for this payment. The three documents are:

- proposal: `Settle 15 EUR to Birch Supply for bill BILL-3.`
- receipt: `Delivery receipt for bill BILL-3 from Birch Supply.`
- mandate: `The clerk may settle 15 EUR to Birch Supply for bill BILL-3 only when the delivery receipt is attached.`

The proposal is the payment. The receipt shows that the delivery named by the mandate is present. Neither sentence is a strategy, an instrument, or an order type. The mandate is a payment condition. That condition belongs to `mandate_compliance`, which #140 allows to be N/A only when no mandate was extracted (`README.md:13`, `evaluate.ts:251`).

## 3. Smallest distinction

The trusted bit is not in the model JSON. Today the only trusted signals are `trustedAdapterIds` (a host allowlist, `README.md:19-21`) and the hardcoded mandatory set at `evaluate.ts:246`. A model-generated empty `requirementIds` must not skip the check. The scratch confirmed that: empty strategy requirements plus status `not_applicable` stays UNCERTAIN on the real gate.

If a later host needs payments on this contract, the smallest addition is a host field on the case, next to `precheck`, never copied into the prompt:

- `explicit`: a strategy applies. Keep the current gate. `fulfilled` or `contradicted` only. `contradicted` BLOCKs.
- `not_foreseen`: the host, not the model, says this action type has no strategy. Rewrite this check to `not_applicable` only when the model also extracted no strategy requirement. An extracted strategy requirement disagrees with the host and stays `not_verifiable`.
- `source_missing`: a strategy might apply and the governing source was not supplied. Force this check to `not_verifiable`.

`evaluate.ts:102-103` already lets `not_applicable` through and holds `not_verifiable`. The missing piece is who may set that status. It has to be the host flag, after the model output is parsed, not `applicability.status` from the model.

## 4. Scratch results

Not committed. The real gate was called unchanged. The host flag was applied only in the scratch, by rewriting this one check's status and reapplying the `finish` rule.

| Situation | Result |
| --- | --- |
| Helio fixture, strategy check set to `contradicted` | real gate BLOCK |
| Strategy source removed, model says `not_applicable` | real gate UNCERTAIN |
| Empty strategy list, model says `not_applicable` | real gate UNCERTAIN |
| Model applicability `not_applicable` on this check | real gate UNCERTAIN, `APPLICABILITY_CONFLICT` `$.applicability[1]` |
| Recorded dev-03 A and B, scope `explicit` | frozen UNCERTAIN, public UNCERTAIN |
| Recorded dev-03 A and B, scope `not_foreseen` | frozen ALLOW, public ALLOW |
| Recorded dev-03 A and B, scope `source_missing` | frozen UNCERTAIN, public UNCERTAIN |
| Recorded dev-06 A, scope `not_foreseen` | still UNCERTAIN. `decision_basis` is `not_verifiable` with `quotes` `[]`. The strategy rewrite does not move it. |
| Recorded dev-01 A, scope `not_foreseen` | frozen ALLOW, public UNCERTAIN. The row that blocks is clause `The clerk acts alone.` against `Settle 40 EUR to Alpine Paper for bill BILL-9.`, reading `met`. Those spans share no five-letter word (`comparison-grounding.ts:93`). This answer does not use the pending-as-met path (`comparison-grounding.ts:92`). |

## 5. Counters, with the unit named

Archive, 12 rows = 6 cases × 2 arms. "First" means the first `not_verifiable` check in `CHECK_IDS` order on that row. "Every" means that pattern on any check of any row, including later checks.

| Pattern | Every (check occurrences) | First (rows) |
| --- | --- | --- |
| `decision_basis` `REQUIREMENT_SET_MISMATCH` `evaluate.ts:267-269` | 9 | 9 |
| `order_strategy_consistency` model status `not_applicable` taking `evaluate.ts:277` | 9 | 3 |
| `mandate_compliance` `INVALID_SEMANTIC_EVIDENCE` `evaluate.ts:278-285` | 8 | 0 |

The 9 line-277 occurrences are dev-02 A (first), dev-02 B, dev-03 A, dev-03 B, dev-04 A, dev-04 B, dev-05 A (first), dev-05 B (first), dev-06 B. The 3 first rows are dev-02 A, dev-05 A, dev-05 B. The other 9 rows' first error is the `decision_basis` id mismatch.

dev-01 B also has model status `not_applicable` on this check, but the gate returns at `evaluate.ts:256-257` (`APPLICABILITY_CONFLICT`). It is not in the 9 and it is not a first error. The earlier "8 of 12" sentence was wrong. Its complement, 4 of 12, is not a replay count. The row table is 9 + 3 = 12. There is no fourth first-error row for this check.

The later paid run is a different set of answers. Its line-277 `not_applicable` count is 1 occurrence and 1 first row (dev-01 B). The other 11 first errors are model status `not_verifiable` at the same line, which is a different status and was not part of the 9/3.

## 6. Experiment, not the gate

#140 is a trade-order contract. These payment cases are a mismatched setup for `order_strategy_consistency`: nothing in the bundle is a strategy, and the contract will not turn the check off.

The smallest experiment correction is to stop expecting ALLOW from this check on a payment that has no strategy in the trusted documents. Either put a strategy sentence in the source documents when the question is whether the order matches it, or seal the expected label as UNCERTAIN when the bundle has none. Do not ask the model to emit `not_applicable` for this check. That change is in the case bundle and the sealed labels, not in `evaluate.ts`.
