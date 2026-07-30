# D2 — ERC-8004 Validation artifact v0
**Date:** 2026-07-30 · **Rev:** post-steelman (unsigned draft language)  
**Status:** Spec for GOAT + Intuition · implementation = well-known JSON today  
**Non-goals:** Reputation score · bulk Intuition write · claiming Validation Registry mainnet · claiming cryptographic receipt until v1

**Naming:** Prefer **validation-shaped artifact** / **unsigned validation receipt draft** until hash + validator signature ship.

---

## Role in EIP-8004 terms

EIP-8004 separates **identity**, **reputation**, and **validation**; payments (e.g. x402) are orthogonal.  
ThoughtProof targets the **validation** slot for a **single proposed action**:

| | |
|---|---|
| Identity | Which agent (`chainId` + `tokenId` + registry) — **reference** until registry-verified |
| Reputation | **Not us** (AsterPay/Helixa/others) — we may *read* it as advisory |
| Validation | Did verifier V judge action A under mandate M at time T? |

Public positioning:  
`not_a_reputation_service: true` · `do_not_convert_this_to_agent_reputation_penalty: true`

---

## External verdict taxonomy

| Verdict | Meaning |
|---|---|
| ALLOW | Decision sufficiently supported |
| OBJECT | Resolvable objections → replan → re-verify |
| BLOCK | Not acceptable / not safely resolvable |
| UNCERTAIN | Evidence insufficient |

API may use ALLOW/BLOCK/UNCERTAIN; OBJECT = partner replan semantics. Avoid DENY.

`confidence` = verifier judgment confidence (not risk score).

---

## Artifact schema v0

```json
{
  "$schema": "https://thoughtproof.ai/schemas/erc8004-validation-artifact.v0.json",
  "artifactType": "erc8004.validation.decision.v0",
  "signed": false,
  "agent": {
    "chainId": 8453,
    "tokenId": "1380",
    "registry": "0x8004…",
    "caipId": "eip155:8453/erc721:0x8004…/1380",
    "identityBinding": "operator_declared_reference"
  },
  "validator": {
    "id": "thoughtproof-decision-verification",
    "name": "ThoughtProof Decision Verification",
    "kind": "per-action-decision-validator",
    "url": "https://thoughtproof.ai"
  },
  "request": {
    "decisionPackageHash": null,
    "mandateHash": null,
    "evidenceRoot": null,
    "actionSummary": {}
  },
  "response": {
    "verificationId": "sent_…",
    "verdict": "ALLOW|OBJECT|BLOCK|UNCERTAIN",
    "confidence": null,
    "verifiedAt": "ISO-8601",
    "objections": [],
    "models_used": ["serv-nano"],
    "agent_context": {
      "agent_model_source": "operator_declared",
      "identity_verified": false
    }
  },
  "advisory_context": {
    "note": "Upstream reputation/KYA signals are informational only.",
    "graph_signals": []
  },
  "important_do_not_do": {
    "do_not_convert_this_to_agent_reputation_penalty": true
  },
  "transport": {
    "wellKnownUri": "https://…",
    "onChainValidationRegistry": null,
    "intuitionTriple": null
  },
  "signature": null
}
```

### v1 receipt (not claimed yet)

- Canonical serialization of decision package  
- Computed `decisionPackageHash`  
- Validator signature + alg + key id  
- Verify instructions  
- Optional replan chain binding  

---

## Map: Dackie well-known → artifact v0

Live illustration:  
`https://sentinel.thoughtproof.ai/.well-known/intuition/erc8004/agents/8453/1380/trust-assessment.json`

| Artifact v0 | Dackie trust-assessment.v1 |
|---|---|
| agent.* | `agent.*` |
| validator.* | `provider.*` |
| response.verdict | `verification.verdict` |
| advisory_context | `advisory_context` (AsterPay etc.) |
| important_do_not_do | `important_do_not_do` |
| signed | false |

---

## Related

- Spike proof: `TWO-FLY-CONSUME-VERIFY-PROOF-2026-07-30.json` (v2: atom + AsterPay + BLOCK; identity still declared)  
- Veridex boundary: `VERIDEX-VS-TP-BOUNDARY-2026-07-30.md`  
