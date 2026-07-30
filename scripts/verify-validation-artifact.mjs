#!/usr/bin/env node
/**
 * Portable verifier for ThoughtProof validation artifacts (Ed25519).
 *
 * Zero local repo dependency beyond Node 18+.
 *
 *   node verify-validation-artifact.mjs <artifact.signed.json>
 *   KEYS_URL=https://sentinel.thoughtproof.ai/.well-known/validation-keys.json \
 *     node verify-validation-artifact.mjs ./artifact.json
 *
 * Spec (must match signer):
 * 1. Parse JSON
 * 2. Strip top-level: signature, artifactHash, signed
 * 3. Recursively sort object keys; arrays keep order
 * 4. JSON.stringify (no spaces) UTF-8
 * 5. Ed25519 verify over those bytes
 * 6. artifactHash must equal 0x||sha256(bytes) when present
 */
import {
  createPublicKey,
  createHash,
  verify as cryptoVerify,
} from "crypto";
import { readFileSync } from "fs";
import { pathToFileURL } from "url";

const DEFAULT_KEYS =
  process.env.KEYS_URL ||
  "https://sentinel.thoughtproof.ai/.well-known/validation-keys.json";

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

function bodyForVerify(artifact) {
  const { signature, artifactHash, signed, ...rest } = artifact;
  return rest;
}

function canonicalBytes(obj) {
  return Buffer.from(JSON.stringify(sortKeys(obj)), "utf8");
}

async function fetchKeys(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`keys fetch ${res.status} ${url}`);
  return res.json();
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node verify-validation-artifact.mjs <artifact.signed.json>");
    process.exit(1);
  }
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  const sig = artifact.signature;
  if (!sig?.value || !sig?.keyId) {
    console.log(JSON.stringify({ ok: false, error: "missing_signature" }, null, 2));
    process.exit(2);
  }

  let pem = sig.publicKeyPem;
  let keysMeta = null;
  if (!pem) {
    keysMeta = await fetchKeys(DEFAULT_KEYS);
    const key = (keysMeta.keys || []).find((k) => k.keyId === sig.keyId && k.status !== "retired");
    if (!key?.publicKeyPem) {
      console.log(JSON.stringify({ ok: false, error: "key_not_found", keyId: sig.keyId }, null, 2));
      process.exit(3);
    }
    pem = key.publicKeyPem;
  }

  const body = bodyForVerify(artifact);
  const bytes = canonicalBytes(body);
  const hash = "0x" + createHash("sha256").update(bytes).digest("hex");
  const pub = createPublicKey(pem);
  const sigBuf = Buffer.from(String(sig.value).replace(/^0x/, ""), "hex");
  const signatureValid = cryptoVerify(null, bytes, pub, sigBuf);
  const hashMatch = !artifact.artifactHash || artifact.artifactHash === hash;

  const out = {
    ok: signatureValid && hashMatch,
    signatureValid,
    artifactHashMatch: hashMatch,
    keyId: sig.keyId,
    keysUrl: DEFAULT_KEYS,
    recomputedHash: hash,
    publicKeyRef: `${DEFAULT_KEYS}#${sig.keyId}`,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 4);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
