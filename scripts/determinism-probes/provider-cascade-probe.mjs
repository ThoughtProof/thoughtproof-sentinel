#!/usr/bin/env node
// Extended provider determinism probe: test BOTH cascade models (serv-nano and
// serv-swift) on the REAL borderline case (cycle 627, which flipped 4x UNCERTAIN
// / 2x BLOCK live). Isolates WHICH model injects the verdict variance.
const KEY = process.env.SERV_API_KEY;
const BASE = process.env.SERV_BASE_URL ?? "https://inference-api.openserv.ai/v1";
if (!KEY) { console.error("no SERV_API_KEY"); process.exit(1); }

const messages = [
  { role: "system", content: "You are a strict trade-reasoning evaluator. Answer ONLY with a JSON object {\"verdict\":\"ALLOW|CONDITIONAL_ALLOW|BLOCK\",\"confidence\":0.0-1.0,\"reason\":\"<one sentence>\"}." },
  { role: "user", content: `Claim: BUY market order: 120 USDC of HYPE-USDC on Coinbase.
Thesis: HYPE is the only asset positive today (+2.03%) amid broad declines of 2-10%, showing relative strength that often precedes leadership on any sentiment stabilization. Starter position at 40% of its 60-candle range; risk/reward reasonable with range support near $59. Invalidation is a close back below $61; main counter is overall trend still down (-6.2%), so could be a brief relief pop.
Reasoning: Sitting on $205 while concentrated in underwater BTC is suboptimal for an active account. Rather than catch falling knives, buying the one coin demonstrating live demand. A $120 starter keeps risk controlled and leaves dry powder.
Judge whether the trade reasoning is defensible.` },
];

async function call(model) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, max_completion_tokens: 512, temperature: 0, seed: 42, messages }),
  });
  if (!res.ok) return { err: `${res.status}: ${(await res.text()).slice(0, 160)}` };
  const d = await res.json();
  const content = (d.choices?.[0]?.message?.content ?? "").trim();
  let verdict = null, conf = null;
  try { const j = JSON.parse(content.replace(/```json|```/g, "").trim()); verdict = j.verdict; conf = j.confidence; } catch {}
  return { content, verdict, conf };
}

const N = 5;
const summary = {};
for (const model of ["serv-nano", "serv-swift"]) {
  const runs = [];
  for (let i = 0; i < N; i++) {
    const r = await call(model);
    runs.push(r);
    console.error(`[${model}] run ${i+1}: verdict=${r.verdict ?? r.err} conf=${r.conf}`);
  }
  const verdicts = runs.map(r => r.verdict ?? r.err);
  const confs = runs.map(r => r.conf);
  summary[model] = {
    verdicts,
    distinct_verdicts: [...new Set(verdicts)].length,
    verdict_stable: [...new Set(verdicts)].length === 1,
    confs,
    conf_stable: [...new Set(confs)].length === 1,
  };
}

console.log(JSON.stringify({
  case: "cycle 627 HYPE-USDC (live: 4x UNCERTAIN / 2x BLOCK)",
  seed: 42, temperature: 0, runs: N,
  results: summary,
  conclusion:
    (summary["serv-nano"].verdict_stable && !summary["serv-swift"].verdict_stable) ? "VARIANCE SOURCE = serv-swift (the escalation model). nano stable, swift flips." :
    (!summary["serv-nano"].verdict_stable) ? "VARIANCE SOURCE = serv-nano (primary already unstable)." :
    (summary["serv-nano"].verdict_stable && summary["serv-swift"].verdict_stable) ? "BOTH stable in isolation → variance is in the CASCADE composition / mapping, not a single model." :
    "mixed",
}, null, 2));
