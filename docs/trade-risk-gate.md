# Deterministic Cycle risk gate and decision evaluator

`trade_execution` now has a dedicated action-validity evaluator prompt. It asks
whether the proposed trade satisfies the supplied criteria, not whether research
was performed or a contradiction was accurately discussed. It distinguishes
upper/lower limits, descriptive measurements, inclusive comparisons and the
particular series named in a directional claim. A relevant recorded calculation
or observation can be evidence; a hidden reasoning transcript is not required.
This changes task semantics. Score thresholds, strict response validation,
provenance, source-reference resolution, deadlines and retries are unchanged.
All other modes retain their original evaluator prompts.

The separate optional `trade_risk` request field enables the **enforced**
`cycle-risk-v1` profile. This profile is specific to the Cycle integration:

```json
{"policy":"cycle-risk-v1","side":"long","entry":2000,"stop":1900,
 "size_pct":0.1,"risk_pct":0.01,"leverage":2,"macro_size_mult":0.5}
```

The calling execution host must fill this from the same actual order snapshot
it will execute, not from a model's description. `size_pct` means order notional
divided by equity, not margin fraction. The server recomputes initial stop risk
as `size_pct * abs(entry-stop) / entry`. The permitted fraction is
`min(risk_pct, 0.01) * macro_size_mult`. Risk above 1%, leverage above 2, invalid
prices/sizes, a stop on the wrong side, zero macro size or excess stop risk block
before any inference. The existing Cycle floating-point tolerance of `1e-10`
equity fraction is retained. Nonfinite/underflowed calculations cannot pass.
When evidence is JSON containing `trade_plan`, duplicate order fields must match.
Other free-text contradictions remain part of the semantic evaluation.

Unknown/missing fields and numeric strings/booleans are rejected by public
validation. A defensive direct-engine call with malformed input returns
UNCERTAIN. `gateMode: shadow` cannot disable this gate. Request-supplied ceilings
are not accepted. Passing arithmetic never promotes a model verdict or authorizes
a trade. An invalid evaluator response remains UNCERTAIN, and restrictive model
verdicts remain restrictive.

`meta.trade_risk` reports the checked operands, evidence SHA256, computed risk,
budget, status and stable reason codes. This is **unsigned diagnostic metadata**,
not an independent attestation of exchange/account state or execution authority.
The existing canonical verdict format is unchanged. The full validated request,
including the contract, remains covered wherever a package digest is computed.
Arithmetic assumes the supplied snapshot is truthful/current; fees, gaps,
funding, liquidity and later order mutation are not covered by this profile.

## Migration and scope

The field is optional for existing Sentinel callers; omission retains the
legacy prose-only interface **without this numeric-gate guarantee**. It is not a
claim that arbitrary unstructured trade requests are now safe. The updated Cycle
client always sends the contract and accepts an ALLOW only with a matching pass
receipt, response ID/mode/tier and evidence hash. Missing, stale or mismatched
receipts are integration errors. It independently checks both recomputed
fractions. BLOCK/UNCERTAIN/errors still deny entry. Local risk checks run first.

Deploy the compatible server before restarting the updated Cycle client. An
older server rejects the new field or lacks the receipt; the client fails closed.
The 8-second client timeout, 1%/2x limits and completed paper run are unchanged.
No production routing or runtime credentials are changed by the code patch.

The regression suite exercises the installed router/parser/evaluator with
controlled HTTP completions. The observed Pro counterexample (100 USDT actual
risk versus 50 permitted) blocks before Nano, Swift or Pro can run. Other tests
cover both sides, exact boundaries, macro halt, overflow, duplicate facts,
contract validation, source binding, restrictive/invalid model responses and
unchanged other modes. Such tests establish code behavior, not model quality.
A fresh bounded model probe is required to assess the new prompt.
