# Issue #85 — kind diagnostics and MCP documentation

Observability only: no lexicon, authorization, promotion or money-transfer policy changes. `callerDeclaredKindsDoNotWiden` is unchanged.

## Diagnostics (unsigned)

**Trust boundary:** These diagnostic fields live in `meta.promotion`, outside the M1 signed canonical envelope. Successful M1 verification does NOT authenticate any declared, prose-derived or effective kind, nor the rejecting-rule metadata. Downstream consumers (including independent verifier integrations) must not treat these fields as tamper-proof evidence, authorization, or signed claims. They can be altered without invalidating the M1 signature. Authenticate only the fields actually inside `signed_export.canonical`.

Legacy receipts without the new fields remain valid. A frozen pre-change signed fixture is checked by `src/issue-85-legacy-export.test.ts`; the test also demonstrates that changing diagnostic metadata leaves verification successful while modifying the signed canonical verdict fails.

### Receipt and log contract

Under `meta.promotion` for action_authorization:
- Existing `action_kind` / `mandate_kind`: effective kinds.
- New `prose_action_kind` / `prose_mandate_kind`: kinds before caller overrides.
- Optional `caller_kinds_diagnostic`: declared kinds (only when provided), `caller_kinds_do_not_widen`, and `triggering_rule: callerDeclaredKindsDoNotWiden` when that predicate rejects.

The rule names this predicate's rejection, not necessarily the sole cause of the final verdict. Missing declarations remain omitted. API logs carry enum/boolean metadata, not full action/mandate text. Diagnostics are unsigned metadata outside canonical.v1, not cryptographic proof of classification. Canonical bytes, digest and signature are unchanged.

## MCP contract

Caller kinds apply in the narrowing/BLOCK direction; they are not unconditional overrides. An informational declaration requires matching informational prose on both sides. Unknown/contradictory prose is not rescued by declaring informational. Existing structured-financial exceptions remain unchanged.

Exact fixture-tested informational example (both declared kinds informational):
- Mandate: `FYI an CoS: Agenda fuer morgen posten.`
- Proposed action: `FYI an CoS: Agenda fuer morgen posten.`

This fits the kind check, not a universal ALLOW promise. Other gates still apply. Do not prepend FYI to disguise an action or rephrase until the gate allows it. FYI-prefixed USD/ETH/USDC transfers under this informational mandate remain BLOCK with a mocked all-pass cascade.

## Verification

`src/issue-85-receipt.test.ts` uses the real HTTP handler and engine with external providers/side effects mocked. It checks BLOCK-path receipt and log metadata, exact documentation wording, three transfer counterexamples, named-prose conflict, privacy and signed canonical invariance.

On frozen base `a1747ea`, six new diagnostic assertions fail; two invariance/characterization tests pass. Candidate: all eight pass. Full suite: 680 tests pass. Full typecheck still fails: identical 97 diagnostics on base/candidate after normalizing checkout paths and line numbers; zero new diagnostics. This is not globally green CI.

Offline fixtures are not a replay of the four production receipts. `numeric claim without bound evidence` is a surface-only replacement in `bindObjectionText`, not an independent verdict-changing gate.

## Separate existing ambiguity — not fixed here

With an informational mandate and caller kinds, `FYI: Ship PR #85 now` yields ALLOW under an all-pass mocked cascade on both base and candidate. This is a potential action-vs-reported-content ambiguity, not proof of a live exploit. A characterization test preserves the observation; no authorization policy change is included. No global baseline-zero/zero-false-ALLOW claim is made.
