// Live composed-artifact generator: fires a REAL Sentinel verify, projects the
// response through buildCanonicalSentinelVerdict(), and prints the canonical
// JCS body + its body_hash. This is the ThoughtProof half of the verdict-envelope
// round-trip — the artifact that gets handed to invinoveritas's /witness.
//
// Run: THOUGHTPROOF_API_KEY=... npx tsx scripts/compose-live-artifact.ts
import { composeCanonicalArtifact } from "../src/canonical-verdict.js";
import type { SentinelVerifyResponse } from "../src/types.js";
import { writeFileSync } from "node:fs";

const KEY = process.env.THOUGHTPROOF_API_KEY ?? process.env.SENTINEL_API_KEY ?? "";
const URL = "https://sentinel.thoughtproof.ai/sentinel/verify";

const claim = "open 2x long ETH. Thesis: ETH holds above rising SMA7 and SMA30, RSI 56 leaves room for continuation; measured long with invalidation below SMA7.";
const evidence = "Market: ETH $1800, +4.2% 24h, 7d +12%, price above SMA7 (1750) and SMA30 (1700), RSI14 56.";

(async () => {
  if (!KEY) { console.error("No API key (THOUGHTPROOF_API_KEY)."); process.exit(1); }
  const r = await fetch(URL, {
    method: "POST",
    headers: { "X-Sentinel-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ claim, evidence, mode: "trade_reasoning", tier: "standard" }),
  });
  if (!r.ok) { console.error(`Sentinel ${r.status}: ${await r.text()}`); process.exit(1); }
  const resp = (await r.json()) as SentinelVerifyResponse;

  const { body, jcs, bodyHash } = composeCanonicalArtifact(resp);

  const out = {
    note: "Live ThoughtProof half of the verdict-envelope composition. Hand `jcs` verbatim to invinoveritas POST /witness; a third party recomputes sha256(jcs)=body_hash.",
    generatedAt: new Date().toISOString(),
    verificationId: resp.id,
    verdict: body.verdict,
    body_hash: bodyHash,
    anchored_form: "0x" + bodyHash,
    canonical_body: body,
    jcs,
  };
  const path = "runs/live-composed-artifact.json";
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log("=== LIVE COMPOSED ARTIFACT ===");
  console.log("verificationId:", resp.id);
  console.log("verdict:", body.verdict, "| confidence:", body.confidence);
  console.log("models:", JSON.stringify(body.models));
  console.log("body_hash (sha256 of JCS):", bodyHash);
  console.log("JCS bytes:\n" + jcs);
  console.log("\nsaved →", path);
})();
