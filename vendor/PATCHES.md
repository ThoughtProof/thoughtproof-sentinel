# Vendored pot-cli patches

Do not replace this tarball with upstream `pot-cli@0.8.10`. The installed
`package.json` `version` must remain the ThoughtProof identity below so
`GET /sentinel/health` `pot_cli` (PR #30) distinguishes binaries.

## 0.8.10-tp.1 (2026-09-09)

- Tarball: `vendor/pot-cli-0.8.10-tp.1.tgz`
- Upstream base: pot-cli 0.8.10
- Changes:
  - `appendReasoningNote` — no JS `undefined + note` prefix
  - `recoverCiteableQuote` / `extractMandateVerbatimQuote` — MCP
    `Principal mandate (verbatim quote):` span when the LLM omits quote
  - `coerceQuote` rejects the strings `"undefined"` / `"null"`
  - Provenance path uses `recoverCiteableQuote` before `PROV_FAIL_01`

`src/pot-cli-quote-patch.test.ts` pins version, source markers, and
tarball sha512. Updating the tarball requires updating that pin.

sha512 (hex):
`ca96d9c03ec6f584cd3a4936ff7dcba7d0e372ef4efa5161f63f1bbefd8ab3434f3c4bba9de0e6602d2664a42af2c6bba36c43f7aa9073f7987653132e45bd95`
