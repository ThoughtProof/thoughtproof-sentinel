# Cycle Engine response-contract follow-up

The Cycle Engine's positive synthetic verification received UNCERTAIN with three
missing step quotes on production `cad8e7d` / `pot-cli 0.8.12`. This branch carries
the existing draft PR #87 response-contract work forward onto that published
dependency. It does not claim that response validation alone fixes the provider's
omissions, and it does not relax a verdict or quote requirement.

The published 0.8.12 and historical tp.2 evaluator TypeScript sources are identical
(SHA-256 `5302b8fb14d5179eb2b1be6dce3723ca100673d9477aa624eb9b3671198c118e`). The
existing contract patch therefore applies unchanged. The new vendored candidate
keeps the 0.8.12 package's Node >=22 requirement, bridge 1.2.0 dependency and all
other package files. Its own version is `0.8.12-eval-contract.1`, so health output
does not misidentify the overlay as an unmodified published release.

Malformed assessments produce technical HOLD / public UNCERTAIN, zero confidence
and bounded field-shape diagnostics. A missing field differs from an explicit null
quote. Complete fields still undergo evidence provenance, scoring and existing
cascade policy. A complete secondary ALLOW does not override an invalid primary.
There are no new automatic retries, provider/model changes or order paths.

## Local validation

- Six new Cycle Engine cases fail against the unmodified 0.8.12 package, with the
  draft trace integration present, then pass against the contract overlay.
- All **784 tests in 51 files pass**, including exact citation preservation,
  negative controls, invalid-output handling and promotion restrictions.
- Only HTTP completions are replaced in the new tests; the real installed router,
  parser, evaluator, cascade and native Sentinel engine run. No live model judgment
  is inferred from synthetic responses.
- The archive rebuild is reproducible with TypeScript 5.9.3. Its SHA-256 remains
  `fcfdf5965200fe59e633a849ec468d5350b62918c362368d64a6162485303574` on the second build.
- Full typechecking is still not clean: candidate 96 diagnostics versus 97 on a
  freshly installed `cad8e7d` checkout. Ignoring line/column and checkout-root
  differences, no diagnostics are added; one existing objection-array type error
  is removed. Passing tests must not be reported as a passing full typecheck.

The fixture files preserve the three 17 October requests byte-for-byte. The
positive input includes explicit risk arithmetic, closed-price direction and
pre-decision reasoning; the negative inputs contain contradictory risk or
explicitly absent observations. They are illustrative data, not natural plans.

The next bounded preview check uses each fixture once, irrespective of verdict.
It observes the current provider's output shape on the new candidate. No production
promotion or general overblocking claim follows automatically from those calls.

## Observed preview result

The configured preview of `010431d` completed all three fixed requests on
17 October. The positive fixture returned **ALLOW**; risk contradiction and absent
facts returned **BLOCK**. All three evaluator responses passed the required-field
contract, with three recognized steps each. Non-null public quotes were independently
checked as exact input substrings. This demonstrates a working cited positive path
on this call, not an estimated field-completion rate or a causal A/B proof that the
prompt change alone improved the model.

Two explanation limits remain visible. The existing numeric evidence binder marks
the numeric step's prose `objection_unverified` in both the positive and risk cases,
even though their quoted arithmetic can be checked directly. In the risk case,
one directional quote fails provenance and is dropped/capped at 0.25; the final
BLOCK is retained. A valid response schema does not guarantee a good explanation.
No score was raised or objection check removed to obtain the positive verdict.

The initial preview inherited generic mock provider credentials and an OpenAI
endpoint. One request failed with HTTP 500 / upstream 401 before a verdict; the
remaining requests were stopped. A separate preview of the identical commit used
deployment-scoped copies of the production SERV endpoint and credential, then ran
the three preregistered cases once each. Project-wide environment definitions and
production routing were not modified. No credential value was written into source
or evidence. The failed attempt remains separate from the three graded controls.

Configured preview:
https://thoughtproof-sentinel-12za2fjm1-rauls-projects-820227a7.vercel.app

The Cycle Engine evidence bundle is
`validation/sentinel_contract_followup_20261017/` in its separate repository.
Natural-plan quality and overblocking remain unassessed; no trading run was restarted.
