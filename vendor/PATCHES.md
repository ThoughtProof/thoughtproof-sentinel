# Vendored pot-cli patches

Do not replace this tarball with upstream `pot-cli@0.8.10`. The installed
`package.json` `version` must remain the ThoughtProof identity below so
`GET /sentinel/health` `pot_cli` (PR #30) distinguishes binaries.

## 0.8.10-tp.2-eval-contract.4 (local required-field request, 2026-09-29)

- Strict evaluator requests add a compact system-message contract with every
  actual host step ID and explicit score, reasoning and quote requirements.
- The original rubric and complete user message are preserved. This is a
  prompt intervention, not provider-enforced structured output.
- No model, provider options, validation, scoring, quote checks or cascade
  policy changes; incomplete responses still hold without retry or repair.
- The live diagnostic observation remains negative. Reduced field omissions
  require a separately bounded live comparison, not synthetic model replies.
- Prior archive and manifest remain; rebuild offline with the existing script.
- Archive: `vendor/pot-cli-0.8.10-tp.2-eval-contract.4.tgz`.
- sha512 (hex): `261a8beffc677c0717955b59992dced805c22207fb165ed50feafc51c22e16a940138506d20a373c0dbfb78f6cf71e2a2fc2392b86d9a5d23dce9b1756a53e57`

## 0.8.10-tp.2-eval-contract.3 (local shape diagnostics, 2026-09-29)

- Adds `plv.evaluator-shape.v1` metadata: absent fields, wrong types, empty
  text, out-of-range scores and known nested assessment containers are distinct.
- At most eight row samples across the root and fixed container names;
  no raw values, arbitrary keys or unknown model IDs are exposed.
- Validation, scores, quote checks, prompts and cascade decisions are unchanged.
  Sampling diagnostics does not truncate validation or authorize a repair.
- The prior archive and manifest remain available. The original live Q-03
  response text is unknown; these diagnostics cannot reconstruct it.
- Rebuild offline: `node scripts/build-evaluator-contract-vendor.mjs`.
- Archive: `vendor/pot-cli-0.8.10-tp.2-eval-contract.3.tgz`.
- sha512 (hex): `e7b55c590e5d31291cfbdbd43bbfedbd4c9ff1f0e054a7a9f3f01607fc4b09f4f4cb0c7e7e9d49379b58192652c21719f9cc268858b44f2df619c7b385c82822`

## 0.8.10-tp.2-eval-contract.2 (local compatibility correction, 2026-09-29)

- Derived `predicate` is no longer a required model field. Any incoming label
  is discarded; existing provenance checks and score floors compute the output.
  This preserves usable reasons when only the redundant label is missing or
  uses another mode's vocabulary.
- Required step coverage, numeric scores, nonempty reasons and explicit quote
  fields remain checked. Invalid assessments retain their technical HOLD.
- Only actual host-created Tier 1 result objects skip provenance; model text
  starting with `[TIER1` cannot impersonate the internal stage.
- The earlier archive and manifest are retained; live negative results are not
  relabeled. This is an offline correction, not a demonstrated model improvement.
- Rebuild offline: `node scripts/build-evaluator-contract-vendor.mjs`.
- Archive: `vendor/pot-cli-0.8.10-tp.2-eval-contract.2.tgz`.
- sha512 (hex): `6228fcd16048e83321f02e8672071c54c8ebc5f17303ec29f5c2d6af63f65e828ba684335e6ca411e5fe8221822db029040faae125f438b5100a0c46c448f7b7`

## 0.8.10-tp.2-eval-contract.1 (local candidate, 2026-09-29)

- Base remains the exact tp.2 archive below; original source and archive retained.
- `strictOutputContract` opts into validation before scoring: each expected ID
  exactly once, numeric score in [0,1], nonempty reason, mode-compatible predicate,
  and explicit string-or-null quote. Unused optional metadata is not required.
- Invalid output returns technical HOLD, no fabricated steps or semantic BLOCK.
  One model request per strict evaluator invocation; no hidden format retries.
- Existing quote provenance, score floors and cascade policy remain unchanged.
  Sentinel opts in and prevents promotion around any invalid evaluator stage.
- Rebuild offline: `node scripts/build-evaluator-contract-vendor.mjs`.
  Runtime JS and sourcemaps are emitted with pinned installed TypeScript; the
  declaration overlay is explicit in that script. Installed package and archive
  are tested separately from mocked evaluator tests.
- Archive: `vendor/pot-cli-0.8.10-tp.2-eval-contract.1.tgz`.
- sha512 (hex): `4184e1152b4e0a29f22290531cbe00bfd6e6738220638c6e5e457e4ec4ee0f72c6d97871c0dffdb555baae1296b3e5b8b9477a2fec1443b1ccac1c07d893e948`

## 0.8.10-tp.2 (2026-09-11)

- Tarball: `vendor/pot-cli-0.8.10-tp.2.tgz`
- Upstream base: pot-cli 0.8.10 (continues 0.8.10-tp.1)
- Changes (in addition to tp.1):
  - `extractMandateVerbatimQuote` / `recoverCiteableQuote` also
    recover suite `USER INSTRUCTION:` (cut before `WALLET BALANCE:` /
    `AGENT PROPOSED ACTION:` / `AGENT REASONING:`) so cascade
    provenance can cite suite-format evidence (#66 Track 1b). MCP
    `Principal mandate (verbatim quote):` remains first.

`src/pot-cli-quote-patch.test.ts` pins version, source markers, and
tarball sha512. Updating the tarball requires updating that pin.

sha512 (hex):
`97214d724a7babef496f6360cb5b3e89b95c80b46ae55464a65276d209b3097108f5ad61f5acc9e6f2f2f4038e3d0d44822ef3a5aa4fb1d341f5e81863082804`

## 0.8.10-tp.1 (2026-09-09)

- Tarball: `vendor/pot-cli-0.8.10-tp.1.tgz` (superseded; not shipped)
- Upstream base: pot-cli 0.8.10
- Changes:
  - `appendReasoningNote` — no JS `undefined + note` prefix
  - `recoverCiteableQuote` / `extractMandateVerbatimQuote` — MCP
    `Principal mandate (verbatim quote):` span when the LLM omits quote
  - `coerceQuote` rejects the strings `"undefined"` / `"null"`
  - Provenance path uses `recoverCiteableQuote` before `PROV_FAIL_01`

sha512 (hex):
`ca96d9c03ec6f584cd3a4936ff7dcba7d0e372ef4efa5161f63f1bbefd8ab3434f3c4bba9de0e6602d2664a42af2c6bba36c43f7aa9073f7987653132e45bd95`
