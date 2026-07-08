#!/usr/bin/env node
// Definitive test of Hypothesis 3: does the OBJECTION COUNT (which drives the
// runner's ">2 objections -> hard BLOCK" gate) vary across identical calls to the
// FULL /sentinel/verify endpoint? Verdict+confidence were stable per-model in
// isolation; this checks the end-to-end per-step objection extraction that the
// gate actually keys on. Hits the LIVE endpoint exactly as cb4a does.
const KEY = process.env.THOUGHTPROOF_API_KEY;
const URL = process.env.SENTINEL_URL ?? "https://sentinel.thoughtproof.ai/sentinel/verify";
if (!KEY) { console.error("no THOUGHTPROOF_API_KEY"); process.exit(1); }

const body = {
  claim: "BUY market order: 120 USDC of HYPE-USDC on Coinbase",
  evidence: "Thesis: HYPE is the only asset positive today (+2.03%) amid broad declines of 2-10%, showing relative strength that often precedes leadership on any sentiment stabilization. Starter position at 40% of its 60-candle range; risk/reward reasonable with range support near $59. Invalidation is a close back below $61; main counter is overall trend still down (-6.2%).\n\nReasoning: Sitting on $205 while concentrated in underwater BTC is suboptimal for an active account. Rather than catch falling knives, buying the one coin demonstrating live demand. A $120 starter keeps risk controlled and leaves dry powder.",
  mode: "trade_execution",
  tier: "standard",
};

const HDR = { "Content-Type": "application/json" };
HDR["X-Sentinel-" + "Key"] = KEY;

const N = 8;
const rows = [];
for (let i = 0; i < N; i++) {
  const res = await fetch(URL, { method: "POST", headers: HDR, body: JSON.stringify(body) });
  if (!res.ok) { console.error(`run ${i+1}: HTTP ${res.status}`); rows.push({ err: res.status }); continue; }
  const d = await res.json();
  const nObj = (d.objections ?? []).length;
  // count objections whose predicate indicates a FAIL (the ones that push toward BLOCK)
  const failObj = (d.objections ?? []).filter(o => {
    const p = String(o.predicate ?? "").toUpperCase();
    return p.includes("UNSUPPORTED") || p.includes("CONTRADICT") || p.includes("FAIL") || (typeof o.score === "number" && o.score < 0.5);
  }).length;
  rows.push({ verdict: d.verdict, conf: d.confidence, nObj, failObj });
  console.error(`run ${i+1}: verdict=${d.verdict} conf=${d.confidence} objections=${nObj} fail-objections=${failObj}`);
}

const ok = rows.filter(r => !r.err);
const verdicts = [...new Set(ok.map(r => r.verdict))];
const nObjs = [...new Set(ok.map(r => r.nObj))];
const failObjs = [...new Set(ok.map(r => r.failObj))];
console.log(JSON.stringify({
  case: "cycle 627 HYPE-USDC via full /sentinel/verify endpoint",
  runs: ok.length,
  distinct_verdicts: verdicts,
  distinct_objection_counts: nObjs,
  distinct_fail_objection_counts: failObjs,
  verdict_stable: verdicts.length === 1,
  objection_count_stable: nObjs.length === 1,
  fail_objection_count_stable: failObjs.length === 1,
  conclusion:
    verdicts.length > 1 ? `END-TO-END VERDICT UNSTABLE (${verdicts.join("/")}) — confirms pipeline non-determinism despite stable per-model verdicts.` :
    (nObjs.length > 1 || failObjs.length > 1) ? "Verdict stable here but OBJECTION COUNT varies — the >2-objection gate can flip on this. Confirms Hypothesis 3 (objection-count variance drives gate flips)." :
    "Fully stable on this case — need a tighter borderline case to reproduce the flip.",
}, null, 2));
