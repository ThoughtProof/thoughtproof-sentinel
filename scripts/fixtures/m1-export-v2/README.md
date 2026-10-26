# Canonical v2 signed-export vectors (ADR-0022)

Same envelope domain and vector-only kid as `scripts/fixtures/m1-export/`.
The private seed is fixture material in `scripts/gen-m1-export-v2-vectors.mjs`
(the same vector-only seed as the v1 generator). It is not a production key.

v1 files under `scripts/fixtures/m1-export/` are not produced here.

## Provenance on the valid vector

- `releaseId`: `da6b6378e105d0c7e1f810bbe237d2f23c55c103`
- `policy`: `adr-0019-cascade-promotion-2026-08-08+p0-primary-error-fail-closed+p0-objective-mismatch-fail-closed+p0-informational-allowlist+p0-unknown-action-fail-closed+p0-unclassified-abstention-uncertain+p0-caller-declared-kinds`
- `potCli`: `0.8.12` (fixture constant; live exports call `getPotCliVersion()`)

`export-v2-omitted-optionals.json` is the same projection with those three fields absent.
`export-v2-tampered-canonical.json` keeps the valid signature over a mutated canonical string.

## Verify locally

```bash
node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export-v2/export-v2-valid.json \
  --keys data/thoughtproof-keys.json --now 1782916498 --allow-vector-only

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export-v2/export-v2-omitted-optionals.json \
  --keys data/thoughtproof-keys.json --now 1782916498 --allow-vector-only

node scripts/verify-canonical-export.mjs scripts/fixtures/m1-export-v2/export-v2-tampered-canonical.json \
  --keys data/thoughtproof-keys.json --now 1782916498 --allow-vector-only
```

Regenerate: `node scripts/gen-m1-export-v2-vectors.mjs`
