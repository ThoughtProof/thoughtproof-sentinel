# ADR-0023 addendum: key-to-account migration proof

**Status:** Proposed (2026-10-31). Draft implementation of the migration proof and the admin pin path. Not an enablement GO, not a suite GO, and not a production run.
**Parent:** [ADR-0023](ADR-0023-principal-signed-mandate.md) (Proposed). [Integration plan](ADR-0023-integration-plan.md) (Proposed). [Key-pinning admin process](ADR-0023-key-pinning-admin-process.md) (Proposed). This addendum does not change those statuses.
**Decider:** Founder

Founder GO for this draft authorizes the read-only census and `pinPrincipalKeyAsAdmin`. It does not authorize a production pin, a change to `SENTINEL_MANDATE_PROOF_ENFORCE`, a deploy, or account enablement. `registerPrincipalKey` stays locked.

Placeholder strings in tests are fixtures. They are not production keys.

## What this proves

`src/mandate-key-account-census.ts` reads one `SENTINEL_API_KEYS` value with the same record grammar as `parseSentinelApiKeyRecords` (`key:platform:agent_id:account_id`). The account id is only the explicit field. The platform and the agent id are not copied into it. A colon inside the account id stays inside that field.

The census is deterministic only when every existing key has exactly one non-empty account id:

| Condition | Census |
|---|---|
| Two different keys, one account (rotation overlap: old key and new key both present) | `deterministic: true`, `overlap_accounts: 1`, `rotation_overlap_keys: 2`. `keysShareOneAccount` is true. |
| The same key twice with the same account | `deterministic: true`, `duplicate_rows` counts the extra row. Still one account. |
| The same key with two account ids | `deterministic: false`, `ambiguous_keys: 1`. The key does not map. |
| A key with no account field | `deterministic: false`, `unmapped_keys` increments. That is the migration gap. It is not an invented account. |
| An empty or unreadable value | `deterministic: false` and zero counts. An empty file is not a successful migration. |
| A revoked key that is still present and has one account | `deterministic: true`, `revoked_keys: 1`. `inspectKeyMapping` reports `maps: true`, `revoked: true`, `authorizesExecution: false`. |
| A revoked key with two accounts, or with no account | `deterministic: false`. `revoked_ambiguous` or `revoked_unmapped` increments. |
| A revoked key that is not in the record set | `revoked_absent` increments. It is not an existing key, so it does not by itself make a clean set non-deterministic. |

`authorizes_execution` on the report is false. `inspectKeyMapping` sets `authorizesExecution: false` for a clean key and for a revoked key. A mapping is not an authorization and it is not ALLOW. The report fields are counts and two booleans. The functions that the script calls do not return key material or account ids.

Revocation here is an explicit list passed beside the record string. It is not a new environment variable and it does not change `validateApiKey`. A revoked key that remains in `SENTINEL_API_KEYS` still has one server account until an operator removes that row. The census counts it and refuses to treat it as authorization.

## No key under enforce

When `SENTINEL_MANDATE_PROOF_ENFORCE` is exactly `true`, a request with no key does not reach a verdict of ALLOW.

| Auth | Request | Result |
|---|---|---|
| `SENTINEL_AUTH_REQUIRED` is exactly `true` | `X-Sentinel-Key` missing or blank | HTTP 401 `UNAUTHORIZED` from `validateApiKey`, before the mandate gate and before the engine. |
| Auth is not exactly `true` | Key missing, blank, or present | `evaluateMandateRequestPath` returns HTTP 503 `ACCOUNT_UNAVAILABLE`. No `verdict`. The engine, payment gate, and billing are not called. |

Both results fail closed. This addendum does not set the enforce flag. Tests set it in the test process only.

## Count script

`scripts/mandate-key-account-census.ts` prints one JSON object and exits. Exit 0 means the report was produced. It does not mean the mapping is deterministic. Exit 2 prints a fixed `unreadable` object and does not include the path, the record string, or a key.

```
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  scripts/mandate-key-account-census.ts --file ./local-keys.txt

node --experimental-strip-types --disable-warning=ExperimentalWarning \
  scripts/mandate-key-account-census.ts --file ./local-keys.txt --revoked ./local-revoked.txt
```

`--revoked` is one key per line, local, and is not printed. A later operator run, in a process that already has the variable, can pass `--from-env`. This draft does not run that against production and does not put production records in the repository.

The report keys are `deterministic`, `authorizes_execution`, `records`, `distinct_keys`, `mapped_keys`, `unmapped_keys`, `ambiguous_keys`, `empty_keys`, `distinct_accounts`, `overlap_accounts`, `rotation_overlap_keys`, `revoked_keys`, `revoked_absent`, `revoked_ambiguous`, `revoked_unmapped`, and `duplicate_rows`. `authorizes_execution` is false. Any other shape is `unreadable`.

## Activation

Merging this draft and a deterministic census do not activate mandate enforcement. `defaultMandateRequestDeps` still supplies `manifestStore: null` and `readPolicy: () => 'unreadable'`. A protected check cannot load a pinned key from a null store, and an unreadable policy is HTTP 503 `POLICY_UNAVAILABLE`, not legacy and not protected.

Activation additionally requires both of these, on top of a separate enablement GO:

- A productive manifest store that answers for the account. The null default is not that store.
- A readable account policy. The default reader does not return `legacy` or `protected`.

Until both exist, do not treat a merged pin function or a green census as permission to set `SENTINEL_MANDATE_PROOF_ENFORCE` or to enable an account.

## Non-goals

- No change to `SENTINEL_MANDATE_PROOF_ENFORCE` or any other environment variable.
- No production census run and no production pin.
- No deploy, no merge, and no paid-suite trigger-path edit.
- The census does not write, does not call `POST /sentinel/verify`, and does not enable an account.
