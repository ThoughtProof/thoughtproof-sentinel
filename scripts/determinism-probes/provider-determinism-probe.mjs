#!/usr/bin/env node
// Provider determinism probe: fire the SAME serv-nano chat completion N times
// with temperature=0, seed=42 against openserv.ai. If output varies, the hosted
// provider does NOT honour seed -> passing seed through in cascade.ts won't help,
// only best-of-N will. If output is byte-stable -> seed works -> the KLEIN fix
// (pass seed/temp through EvalOptions) is sufficient.
const KEY = process.env.SERV_API_KEY;
const BASE = process.env.SERV_BASE_URL ?? "https://inference-api.openserv.ai/v1";
if (!KEY) { console.error("no SERV_API_KEY"); process.exit(1); }

// A deterministic-sensitive prompt: ask for a short structured judgement, the
// kind the grader makes. Temperature 0 + seed should pin it if honoured.
const messages = [
  { role: "system", content: "You are a strict evaluator. Answer ONLY with a JSON object {\"verdict\":\"ALLOW|CONDITIONAL_ALLOW|BLOCK\",\"confidence\":0.0-1.0,\"reason\":\"<one sentence>\"}." },
  { role: "user", content: "Claim: BUY market order: 120 USDC of HYPE-USDC on Coinbase. Evidence: Thesis: HYPE is the only asset positive today (+2.03%) amid broad declines; relative strength often precedes leadership. Reasoning: rotating idle USDC into the day's strongest relative performer with a starter position. Judge whether the reasoning is defensible." },
];

async function call() {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "serv-nano",
      max_completion_tokens: 512,
      temperature: 0,
      seed: 42,
      messages,
    }),
  });
  if (!res.ok) return { err: `${res.status}: ${(await res.text()).slice(0, 160)}` };
  const d = await res.json();
  return { content: (d.choices?.[0]?.message?.content ?? "").trim(), fp: d.system_fingerprint ?? null };
}

const N = 5;
const outs = [];
for (let i = 0; i < N; i++) {
  const r = await call();
  outs.push(r);
  const short = r.err ? `ERR ${r.err}` : r.content.replace(/\s+/g, " ").slice(0, 120);
  console.error(`run ${i + 1}: ${short}${r.fp ? `  [fp:${r.fp}]` : ""}`);
}

const contents = outs.map((o) => o.content ?? o.err);
const uniq = [...new Set(contents)];
console.log(JSON.stringify({
  model: "serv-nano", temperature: 0, seed: 42, runs: N,
  distinct_outputs: uniq.length,
  deterministic: uniq.length === 1,
  verdict: uniq.length === 1
    ? "PROVIDER HONOURS SEED — deterministic. Fix = KLEIN (pass seed/temp through cascade.ts EvalOptions)."
    : `PROVIDER IGNORES SEED — ${uniq.length}/${N} distinct outputs. Fix = MITTEL (server-side best-of-N; seed pass-through alone won't help).`,
  distinct_samples: uniq.map((c) => (c || "").slice(0, 200)),
}, null, 2));
