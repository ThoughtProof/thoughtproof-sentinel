# Vendored pot-cli patches

Do not replace this tarball with upstream `pot-cli@0.8.10`. The installed
`package.json` `version` must remain the ThoughtProof identity below so
`GET /sentinel/health` `pot_cli` (PR #30) distinguishes binaries.

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
