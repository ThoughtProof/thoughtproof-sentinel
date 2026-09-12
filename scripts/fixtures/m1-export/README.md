# M1 signed canonical export vectors

## Key separation (non-negotiable)

| kid | status | private material | use |
|---|---|---|---|
| `tp-sentinel-export-ed25519-2026-09-vector` | `vector-only` | seed in `gen-m1-export-vectors.mjs` only | fixtures / paired checks |
| `tp-sentinel-export-ed25519-2026-09` | `active` | **env only** `SENTINEL_EXPORT_PRIVATE_KEY` | production `signed_export` |

## alg names (do not cross-compare)

- **Export envelope** field `alg`: `Ed25519`
- **Key document** field `alg`: `EdDSA` (JOSE / RFC 8037)
- Same curve. Do not string-equals the two fields.

Key document schema: `thoughtproof.keys.v1` (OKP + TP status extensions). **Not** a pure JWKS.

## Canonical fixture

- digest: `0x419c360db82ee72be3411acd2d30f560b3f62842c2162fa3cb4a08c1fa4ce65a`
- verificationId: `sent_9f3c2a7b1e004d68`

## Valid vector — expected signedInput bytes

Domain `thoughtproof.sentinel.export.v1` UTF-8, then `0x00`, then JCS of the signed fields (including `validUntil`).

```
signedInputHex (794 bytes):
74686f7567687470726f6f662e73656e74696e656c2e6578706f72742e7631007b22616c67223a2245643235353139222c226172746966616374536368656d61223a2273656e74696e656c2e766572646963742e63616e6f6e6963616c2e7631222c2263616e6f6e6963616c223a227b5c2261706956657273696f6e5c223a5c2273656e74696e656c2d6170692d302e312e305c222c5c226172746966616374536368656d615c223a5c2273656e74696e656c2e766572646963742e63616e6f6e6963616c2e76315c222c5c22636f6e666964656e63655c223a38342c5c226576616c756174656441745c223a313738323931363439382c5c226d6f64655c223a5c2274726164655f657865637574696f6e5c222c5c226d6f64656c735c223a7b5c227072696d6172795c223a5c22736572762d6e616e6f5c222c5c227365636f6e646172795c223a5c22736572762d73776966745c227d2c5c226f626a656374696f6e735c223a5b5c22737465705f303a20446972656374696f6e20636c61696d20766572696669656420616761696e7374206d61726b657420646174612e5c225d2c5c22726561736f6e696e675c223a5c22416c6c2073746570732061646571756174656c7920737570706f72746564206279207468652065766964656e63652e5c222c5c22746965725c223a5c227374616e646172645c222c5c22766572646963745c223a5c22414c4c4f575c222c5c22766572696669636174696f6e49645c223a5c2273656e745f396633633261376231653030346436385c227d222c22646967657374223a22307834313963333630646238326565373262653334313161636432643330663536306233663632383432633231363266613363623461303863316661346365363561222c226b65794964223a2274702d73656e74696e656c2d6578706f72742d656432353531392d323032362d30392d766563746f72222c227369676e65644174223a313738323931363439382c2276616c6964556e74696c223a313738333030323839382c22766572696669636174696f6e4964223a2273656e745f39663363326137623165303034643638227d
```

## Verify order (PriorSeal §4)

1. Resolve keyId (status / notBefore / notAfter) → `DECISION_SIGNER_UNTRUSTED` on fail
2. Verify signature over `domain || 0x00 || JCS(fields)` → `DECISION_SIGNATURE_INVALID` on fail
3. Recompute sha256(transported canonical) === digest → `DECISION_COMMITMENT_DIGEST_MISMATCH`
4. optional validUntil

`DECISION_SIGNER_UNTRUSTED` is **not** used for a broken signature on a known kid.

## Files

| File | Expect |
|---|---|
| `export-valid.json` | ok with `--allow-vector-only` |
| `export-tampered-canonical.json` | `DECISION_SIGNATURE_INVALID` |
| `export-tampered-validUntil.json` | `DECISION_SIGNATURE_INVALID` |
| `export-wrong-key.json` | `DECISION_SIGNATURE_INVALID` (kid resolves; sig fails under published x) |
| `export-unknown-keyId.json` | `key_not_found` / `DECISION_SIGNER_UNTRUSTED` |

## Verify locally

```bash
node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-valid.json \
  --keys data/thoughtproof-keys.json --now 1782916498 --allow-vector-only

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-valid.json \
  --keys data/thoughtproof-keys.json --now 1782916498; echo exit:$?

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-tampered-canonical.json \
  --keys data/thoughtproof-keys.json --now 1782916498 --allow-vector-only

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-tampered-validUntil.json \
  --keys data/thoughtproof-keys.json --now 1782916498 --allow-vector-only

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-wrong-key.json \
  --keys data/thoughtproof-keys.json --now 1782916498 --allow-vector-only

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-unknown-keyId.json \
  --keys data/thoughtproof-keys.json --now 1782916498 --allow-vector-only
```

Regenerate: `node scripts/gen-m1-export-vectors.mjs`
