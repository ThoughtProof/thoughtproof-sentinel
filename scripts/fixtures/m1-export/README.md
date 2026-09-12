# M1 signed canonical export vectors

**kid:** `tp-sentinel-export-ed25519-2026-09`  
**domain:** `thoughtproof.sentinel.export.v1`  
**canonical fixture digest:** `0x419c360db82ee72be3411acd2d30f560b3f62842c2162fa3cb4a08c1fa4ce65a`  
**keys doc:** `data/thoughtproof-keys.json` → live `GET /.well-known/thoughtproof-keys.json`

## Files

| File | Expect |
|---|---|
| `export-valid.json` | signature valid + digest match |
| `export-tampered-canonical.json` | `digest_mismatch` (transported bytes ≠ digest; do **not** re-verify via fresh /sentinel/verify) |
| `export-tampered-validUntil.json` | `signature_invalid` (validUntil is signed; stretch breaks sig) |

## Verify locally

```bash
node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-valid.json \
  --keys data/thoughtproof-keys.json --now 1782916498
node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-tampered-canonical.json \
  --keys data/thoughtproof-keys.json --now 1782916498
node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export/export-tampered-validUntil.json \
  --keys data/thoughtproof-keys.json --now 1782916498
```

## Receiver rules (PriorSeal M1)

1. Pin keys URL **and** kid out-of-band.
2. Verify envelope signature over `domain || 0x00 || JCS(fields)`.
3. Recompute sha256 over the **transported** `canonical` string; require equality with `digest`.
4. Digest identifies **one issued artifact**, never a fresh verification.
5. Namespace commitment: `thoughtproof.sentinel-decision.v1` / sha256 / lowercase `0x`+64 hex.
6. `validUntil` is envelope-only (not inside canonical.v1).

Regenerate: `node scripts/gen-m1-export-vectors.mjs`
