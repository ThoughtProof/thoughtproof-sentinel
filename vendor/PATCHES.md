# pot-cli release and historical vendored patches

## npm 0.8.12 (2026-10-10)

Sentinel pins the published `pot-cli@0.8.12` exactly. It keeps the tp.2
quote and reasoning fixes from
[pot-cli PR #52](https://github.com/ThoughtProof/pot-cli/pull/52).
[pot-cli v0.8.12](https://github.com/ThoughtProof/pot-cli/releases/tag/v0.8.12)
pins `@pot-sdk2/bridge` to the tested `1.2.0`, reads `--version` from the
installed package, and requires Node.js `>=22`. The `0.8.11` range selected
`@pot-sdk2/bridge@1.3.0`, which removed `checkAuthorVerifierSeparation` and
failed CLI module load on a fresh install.
`GET /sentinel/health` reports the installed package version as `pot_cli`.
The older tarballs below are retained as historical rollback artifacts.

- Registry tarball: `https://registry.npmjs.org/pot-cli/-/pot-cli-0.8.12.tgz`
- Registry sha256: `aaf93fe02d58e804323ccd1836ec00e268269db398af406adb905a7c67701ad1`
- npm shasum (sha1): `177d70d541adc5956d2c1fd35a66d1cf9ccefbb5`
- Lockfile integrity:
  `sha512-8hM8jsVtZXNW+rFdqQw0vD9UbFvSG6HINB8s5JtY7ZvH3pqH7wjgNDz3W2Y4g3rmsexGlv14J4gcojzOjIvMfA==`
- Tag `v0.8.12`: `d43840434be73e850c2266ce10f523b56de22567`
- Engines: Node.js `>=22`
- Published file count: 599

`src/pot-cli-quote-patch.test.ts` pins the exact dependency, registry URL,
lockfile integrity, installed version, source markers, and behavior.
Update that pin and this document together when upgrading.

## npm 0.8.11 (2026-10-09, superseded)

Published `pot-cli@0.8.11` contains the tp.2 quote and reasoning fixes from
[pot-cli PR #52](https://github.com/ThoughtProof/pot-cli/pull/52).
`0.8.12` is the release Sentinel installs. The `0.8.11` CLI bridge range
selects `@pot-sdk2/bridge@1.3.0`, which lacks an export required by the CLI
entry point.

- Registry tarball: `https://registry.npmjs.org/pot-cli/-/pot-cli-0.8.11.tgz`
- Registry sha256: `2c58ea07b9edc864609c56bd93578cbb6ec793c4bd79a63a60dc0228b3e890d5`
- Lockfile integrity:
  `sha512-XLejury6J6xe8cK/LUcBPMxx8qdMe3eP91NIr8b92yMaO1uJy8evUGD2kAPxDt4P1RylRApoaIBr2Sj+BuJLRw==`
- Tag `v0.8.11`: `003ad27a2187e4173405d6258be888cb567eb5ed`, with the same
  tree as the tested head `5555360b346f9f3e4dd724a093ddbba17905af9f`.

[Sentinel PR #90](https://github.com/ThoughtProof/thoughtproof-sentinel/pull/90)
tested a local pack on localhost against tp.2: both sides passed 27/27
action-authorization cases. That pack has sha256
`eb32000c3b3a0f246995ff1ce0c09dc5e38a0a6fb1ed3cc0effa64b35b9f7f16`.
The compressed packages differ, but their decompressed tar bytes are
identical (sha256
`f0373a4f1dbc7897c9b188ad9ee053e803c04f1c1ecfd9dad6275b19c679f9da`).
All 599 published files also match a fresh build of the release commit.
The compression implementation responsible for the difference is unconfirmed.

## 0.8.10-tp.2 (2026-09-11, superseded)

- Tarball: `vendor/pot-cli-0.8.10-tp.2.tgz`
- Upstream base: pot-cli 0.8.10 (continues 0.8.10-tp.1)
- Changes (in addition to tp.1):
  - `extractMandateVerbatimQuote` / `recoverCiteableQuote` also
    recover suite `USER INSTRUCTION:` (cut before `WALLET BALANCE:` /
    `AGENT PROPOSED ACTION:` / `AGENT REASONING:`) so cascade
    provenance can cite suite-format evidence (#66 Track 1b). MCP
    `Principal mandate (verbatim quote):` remains first.

Do not use unpatched upstream `pot-cli@0.8.10` as a rollback.
Before the npm switch, `src/pot-cli-quote-patch.test.ts` pinned this
version, source markers, and tarball sha512.

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
