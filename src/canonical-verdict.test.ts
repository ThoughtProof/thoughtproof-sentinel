import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  buildCanonicalSentinelVerdict,
  canonicalizeVerdict,
  verdictBodyHash,
  composeCanonicalArtifact,
} from "./canonical-verdict.js";
import type { SentinelVerifyResponse } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The committed fixture + its known hash (verdict-envelope/canonical.json, merged
// in PR #1 and independently sha256-recomputed by invinoveritas as 419c360d…).
// This is the byte-exact target the builder MUST reproduce from a response.
const FIXTURE_HASH = "419c360db82ee72be3411acd2d30f560b3f62842c2162fa3cb4a08c1fa4ce65a";

// A response engineered to project onto the committed fixture body:
// {"apiVersion":"sentinel-api-0.1.0","artifactSchema":"sentinel.verdict.canonical.v1",
//  "confidence":84,"evaluatedAt":1782916498,"mode":"trade_execution",
//  "models":{"primary":"serv-nano","secondary":"serv-swift"},
//  "objections":["step_0: Direction claim verified against market data."],
//  "reasoning":"All steps adequately supported by the evidence.","tier":"standard",
//  "verdict":"ALLOW","verificationId":"sent_9f3c2a7b1e004d68"}
const fixtureResponse: SentinelVerifyResponse = {
  id: "sent_9f3c2a7b1e004d68",
  verdict: "ALLOW",
  confidence: 0.84, // 0-1 float → 84
  reasoning: "All steps adequately supported by the evidence.",
  objections: [
    {
      step_id: "step_0",
      criterion: "Direction claim",
      score: 0.9,
      predicate: "supported",
      quote: null,
      reasoning: "Direction claim verified against market data.",
    },
  ],
  mode: "trade_execution",
  tier: "standard",
  meta: {
    duration_ms: 1200,
    models_used: ["serv-nano", "serv-swift"],
    verified_at: "2026-07-01T14:34:58.000Z", // floor(/1000) → 1782916498
  },
} as SentinelVerifyResponse;

describe("buildCanonicalSentinelVerdict — fixture regression", () => {
  it("reproduces the committed canonical.json body exactly", () => {
    const jcs = canonicalizeVerdict(buildCanonicalSentinelVerdict(fixtureResponse));
    // Read the committed fixture and compare byte-for-byte.
    const fixturePath = resolve(__dirname, "../../verdict-envelope/canonical.json");
    let fixtureBytes: string | null = null;
    try {
      fixtureBytes = readFileSync(fixturePath, "utf8").trim();
    } catch {
      // Fixture repo not checked out next to this one — skip the byte compare,
      // still assert the hash below (the load-bearing invariant).
    }
    if (fixtureBytes) expect(jcs).toBe(fixtureBytes);
  });

  it("reproduces the known anchored hash 419c360d…", () => {
    const hash = verdictBodyHash(buildCanonicalSentinelVerdict(fixtureResponse));
    expect(hash).toBe(FIXTURE_HASH);
  });

  it("evaluatedAt matches the fixture unix-seconds value", () => {
    const body = buildCanonicalSentinelVerdict(fixtureResponse);
    expect(body.evaluatedAt).toBe(1782916498);
  });
});

describe("JCS determinism rules", () => {
  it("omits models.secondary entirely for a solo-tier response (never null)", () => {
    const solo = {
      ...fixtureResponse,
      meta: { ...fixtureResponse.meta, models_used: ["serv-nano"] },
    } as SentinelVerifyResponse;
    const body = buildCanonicalSentinelVerdict(solo);
    expect("secondary" in body.models).toBe(false);
    expect(canonicalizeVerdict(body)).not.toContain("secondary");
  });

  it("omits gate entirely when absent (never null)", () => {
    const body = buildCanonicalSentinelVerdict(fixtureResponse);
    expect("gate" in body).toBe(false);
    expect(canonicalizeVerdict(body)).not.toContain("\"gate\"");
  });

  it("includes gate for an action_authorization response with a mandate", () => {
    const authResp = {
      ...fixtureResponse,
      mode: "action_authorization",
      gate: { mode: "enforce", wouldBlock: true, enforced: true, violations: [{ kind: "unlimited_approval", detail: "spender granted MAX_UINT256" }] },
    } as SentinelVerifyResponse;
    const body = buildCanonicalSentinelVerdict(authResp);
    expect(body.gate).toBeDefined();
    expect(body.gate!.violations).toEqual(["unlimited_approval: spender granted MAX_UINT256"]);
  });

  it("confidence clamps to 0-100 integer", () => {
    const hi = buildCanonicalSentinelVerdict({ ...fixtureResponse, confidence: 1.0 } as SentinelVerifyResponse);
    expect(hi.confidence).toBe(100);
    const lo = buildCanonicalSentinelVerdict({ ...fixtureResponse, confidence: 0 } as SentinelVerifyResponse);
    expect(lo.confidence).toBe(0);
  });

  it("is stable: same response → identical bytes across two runs", () => {
    const a = canonicalizeVerdict(buildCanonicalSentinelVerdict(fixtureResponse));
    const b = canonicalizeVerdict(buildCanonicalSentinelVerdict(fixtureResponse));
    expect(a).toBe(b);
  });

  it("composeCanonicalArtifact returns matching body/jcs/hash", () => {
    const { jcs, bodyHash } = composeCanonicalArtifact(fixtureResponse);
    expect(bodyHash).toBe(FIXTURE_HASH);
    expect(jcs.startsWith("{\"apiVersion\"")).toBe(true);
  });
});
