## 0.8.12-eval-contract.4 — decision task profile (2026-10-18)

- Dependency: `file:vendor/pot-cli-0.8.12-eval-contract.4.tgz`
- Integrity: `sha512-4PYnHvf/bDkM+8qz9gsFv0F4B40wRjSdYoNDVJHsAg0lFfHqYjflcBxJYZkT0JsvSTKrR5s92U9EseAk0aWUCw==`
- SHA256: `6e1e571e5be7f72dd6cc41992918c2c058683d81190e1909f7778db37b7882ac`
- Adds host-selected `evaluationTask: trade_decision` for Sentinel trade execution.
  The dedicated prompt assesses the proposed action against facts and criteria,
  removing the research-completion and reasoning-only task framing.
- Other evaluator tasks retain their messages. Decoder, provenance, score floors,
  numeric thresholds, model selection and retry policy are unchanged.
- The old `.3` archive and its manifest remain preserved. Reproduce with
  `node scripts/build-evaluator-contract-vendor.mjs --install-local`.
- Native Sentinel also adds an opt-in, enforced `cycle-risk-v1` numeric gate;
  this arithmetic is host code, not part of the model prompt or vendor overlay.

## 0.8.12-eval-contract.3 — complete response format after the catalog

Current dependency: `file:vendor/pot-cli-0.8.12-eval-contract.3.tgz`.
Integrity: `sha512-mb+9WRcKGi6rUphXztGu49ZlwOo/YbqhbvCMpHZ9/76RDibY+bP+JzncVqGBV26NaXcD9zuPIQ63QE57XgZioA==`.

The .2 matched preview produced invalid output in all eleven candidate calls.
This revision adds the full required JSON response schema after the source catalog
and explicitly rejects the observed `assessment` alias in the model instructions.
It changes no parser acceptance rules, score, source resolver or retry behavior.
The failed .2 experiment remains preserved; .3 requires separate qualification.

## 0.8.12-eval-contract.2 — source references (18 October 2026)

Current dependency: `file:vendor/pot-cli-0.8.12-eval-contract.2.tgz`.
Integrity: `sha512-gfSRCa7fEDL17o2VxQABwHupLy45vstXKr2i9i+5vgZdxYlMwDWFWs8nm5rk0oyTiKQWo7SVldrVZ6YEg1nF8g==`.

This retains the strict output contract and all existing provenance/score rules.
The opt-in `sourceReferences` evaluation option creates a request-local catalog
of unchanged source lines. A model-selected `quote_ref` is resolved only for its
step's designated source. Unknown/stale/wrong-source references and conflicting
quote strings produce technical HOLD without repair or retry. No reference is
selected automatically, and a source match never raises a score. Original trace,
answer, rubric and chronology remain unchanged. Native Sentinel initially enables
this only for `trade_execution`.

The audit records host-derived source hashes and offsets; the rejected reference
text is not exposed. See `docs/source-references.md` for the exact contract.
Rebuild with `node scripts/build-evaluator-contract-vendor.mjs`; the prior .1
archive and manifest remain available for comparisons.

# pot-cli release and historical vendored patches

## 0.8.12-eval-contract.1 (local compatibility candidate, 2026-10-17)

The strict response contract from draft PR #87 is rebuilt on published 0.8.12.
This avoids reverting its Node >=22 and pinned `@pot-sdk2/bridge@1.2.0` fixes.
The evaluator source in 0.8.12 is byte-identical to the audited tp.2 source
(SHA-256 `5302b8fb14d5179eb2b1be6dce3723ca100673d9477aa624eb9b3671198c118e`).
The builder checks the entire base archive and that source before applying the
unchanged contract overlay. No provider/model switch or new repair retry is added.

Missing response fields yield technical HOLD/UNCERTAIN with bounded field-shape
diagnostics. Explicit null quotes still undergo the original provenance rules.
Valid restrictive judgments stay restrictive; a secondary ALLOW cannot override
an invalid assessment. Six Cycle Engine regression cases exercise the actual
router, evaluator and native engine with synthetic HTTP completions.

- Dependency: `file:vendor/pot-cli-0.8.12-eval-contract.1.tgz`
- Integrity: `sha512-Yz0G3SxHp+iANOvwg1XUUaSniBHh3hehTPkSDc6hcnU7uCOfqzXi+qeVfWGoLr7nY65n+XgFrQvvl23PZpNIgg==`
- SHA-256: `fcfdf5965200fe59e633a849ec468d5350b62918c362368d64a6162485303574`
- Rebuild: `node scripts/build-evaluator-contract-vendor.mjs`
- Manifest: `patches/vendor-manifest.json`; prior .4 manifest is retained separately.

This candidate corrects handling and visibility of malformed assessments. It
does not establish that the live provider will emit complete fields or that
Sentinel's natural trade decisions are reliable.

## npm 0.8.12 (2026-10-10)

Production at the start of this work pins `pot-cli@0.8.12` exactly. It keeps the tp.2
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

`src/pot-cli-quote-patch.test.ts` pins the current overlay, base archive,
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
