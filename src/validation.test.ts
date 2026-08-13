import { describe, expect, it } from 'vitest';
import { validateVerifyRequest } from './validation.js';

describe('validateVerifyRequest', () => {
  const validBody = {
    claim: 'Agent decided to transfer funds',
    evidence: 'Policy requires approval for transfers > $1000. Transfer amount: $500.',
    mode: 'handoff',
  };

  it('accepts valid minimal request', () => {
    const result = validateVerifyRequest(validBody);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.tier).toBe('standard');
      expect(result.data.mode).toBe('handoff');
    }
  });

  it('accepts all 6 modes', () => {
    for (const mode of ['handoff', 'plan_revision', 'memory_write', 'output_synthesis', 'trade_execution', 'trade_reasoning']) {
      const result = validateVerifyRequest({ ...validBody, mode });
      expect(result.valid).toBe(true);
    }
  });

  it('accepts all tiers', () => {
    for (const tier of ['checkpoint', 'standard', 'swift']) {
      const result = validateVerifyRequest({ ...validBody, tier });
      expect(result.valid).toBe(true);
    }
  });

  it('rejects missing claim', () => {
    const result = validateVerifyRequest({ evidence: 'x', mode: 'handoff' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe('claim');
    }
  });

  it('rejects missing evidence', () => {
    const result = validateVerifyRequest({ claim: 'x', mode: 'handoff' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe('evidence');
    }
  });

  it('rejects invalid mode', () => {
    const result = validateVerifyRequest({ ...validBody, mode: 'invalid' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe('mode');
    }
  });

  it('rejects invalid tier', () => {
    const result = validateVerifyRequest({ ...validBody, tier: 'premium' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe('tier');
    }
  });

  it('rejects non-object body', () => {
    const result = validateVerifyRequest(null);
    expect(result.valid).toBe(false);
  });

  it('accepts optional agent_context and trims strings', () => {
    const result = validateVerifyRequest({
      ...validBody,
      agent_context: {
        agent_id: '  tp-pilot-1  ',
        agent_model: 'xai/grok-4',
        agent_runtime: 'cb4a',
        environment: 'paper',
        erc8004: { chainId: 8453, tokenId: 37477 },
        request_id: 'req_abc',
        tags: ['intuition-pilot'],
      },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.agent_context).toEqual({
        agent_id: 'tp-pilot-1',
        agent_model: 'xai/grok-4',
        agent_model_source: 'operator_declared',
        agent_model_role: 'action_generator',
        agent_runtime: 'cb4a',
        environment: 'paper',
        erc8004: { chainId: 8453, tokenId: 37477 },
        identity_source: 'operator_declared',
        identity_verified: false,
        external_request_id: 'req_abc',
        tags: ['intuition-pilot'],
      });
    }
  });

  it('rejects identity_verified=true with operator_declared', () => {
    const result = validateVerifyRequest({
      ...validBody,
      agent_context: {
        agent_id: 'x',
        identity_source: 'operator_declared',
        identity_verified: true,
      },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid agent_model_source', () => {
    const result = validateVerifyRequest({
      ...validBody,
      agent_context: { agent_model: 'x', agent_model_source: 'guessed' },
    });
    expect(result.valid).toBe(false);
  });

  it('normalizes mandate maxAmountUsd/amountUsd aliases for the gate', () => {
    const result = validateVerifyRequest({
      ...validBody,
      mode: 'action_authorization',
      mandate: {
        granted: { maxAmountUsd: 0, asset: 'USDC' },
        action: { amountUsd: 500, asset: 'USDC' },
      },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.mandate?.granted?.maxAmount).toBe(0);
      expect(result.data.mandate?.action?.amount).toBe(500);
    }
  });

  it('accepts valid signed_evidence with key_manifest', () => {
    const result = validateVerifyRequest({
      ...validBody,
      signed_evidence: [{
        type: 'signed_event',
        raw_event: Buffer.from('{"payload":"x","signature":"y"}').toString('base64'),
        signature_scheme: 'ed25519',
        signer_pubkey: 'a'.repeat(64),
        claims: ['owner_signoff'],
        verification: 'required',
      }],
      key_manifest: {
        version: '1',
        keys: [{ pubkey: 'a'.repeat(64), status: 'active' }],
      },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects signed_evidence with wrong type', () => {
    const result = validateVerifyRequest({
      ...validBody,
      signed_evidence: [{
        type: 'unsigned_note',
        raw_event: 'eA==',
        signature_scheme: 'ed25519',
        signer_pubkey: 'a'.repeat(64),
        claims: [],
        verification: 'optional',
      }],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects signed_evidence with unsupported scheme', () => {
    const result = validateVerifyRequest({
      ...validBody,
      signed_evidence: [{
        type: 'signed_event',
        raw_event: 'eA==',
        signature_scheme: 'rsa-pss',
        signer_pubkey: 'a'.repeat(64),
        claims: [],
        verification: 'optional',
      }],
    });
    expect(result.valid).toBe(false);
  });

  // ------------------------------------------------------------
  // F3: strict-mode whitelists (unknown fields rejected)
  // ------------------------------------------------------------
  describe('F3 strict whitelist', () => {
    const goodEvidenceItem = {
      type: 'signed_event',
      raw_event: 'eyJmb28iOiJiYXIifQ==', // {"foo":"bar"}
      signature_scheme: 'ed25519',
      signer_pubkey: 'a'.repeat(64),
      claims: ['test_claim'],
      verification: 'required' as const,
    };

    it('rejects unknown top-level body field with named error', () => {
      const result = validateVerifyRequest({
        ...validBody,
        extra_field: 'silently-would-be-dropped',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const err = result.errors.find((e) => e.field === 'extra_field');
        expect(err).toBeDefined();
        expect(err!.message).toContain('Unknown field');
        expect(err!.message).toContain('extra_field');
      }
    });

    it('rejects multiple unknown top-level fields at once', () => {
      const result = validateVerifyRequest({
        ...validBody,
        typo_moda: 'x',
        another_typo: 'y',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const fields = result.errors.map((e) => e.field);
        expect(fields).toContain('typo_moda');
        expect(fields).toContain('another_typo');
      }
    });

    it('rejects unknown field on signed_evidence[i] with indexed error', () => {
      const result = validateVerifyRequest({
        ...validBody,
        signed_evidence: [{
          ...goodEvidenceItem,
          key_manifest: { version: 'v1', keys: [] }, // wrong location — belongs at top level
        }],
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const err = result.errors.find((e) => e.field === 'signed_evidence[0].key_manifest');
        expect(err).toBeDefined();
        expect(err!.message).toContain('Unknown field');
      }
    });

    it('accepts all known signed_evidence fields (positive control)', () => {
      const result = validateVerifyRequest({
        ...validBody,
        signed_evidence: [{
          ...goodEvidenceItem,
          key_manifest_ref: 'ref://some/manifest',
        }],
      });
      expect(result.valid).toBe(true);
    });

    it('accepts all known top-level fields (positive control)', () => {
      const result = validateVerifyRequest({
        id: 'req_123',
        claim: 'x',
        evidence: 'y',
        mode: 'handoff',
        tier: 'standard',
        gateMode: 'shadow',
        mandate: { granted: { maxAmountUsd: 100 }, action: { amountUsd: 50 } },
        agent_context: { agent_id: 'agent_x' },
        signed_evidence: [goodEvidenceItem],
        key_manifest: {
          version: 'v1',
          keys: [{ pubkey: 'a'.repeat(64), status: 'active' }],
        },
      });
      expect(result.valid).toBe(true);
    });

    it('binds unknown fields into package_digest concern via clear message', () => {
      // Documentary test: the error text must mention *why* strict mode exists,
      // so integrators see the security rationale in the 400 response.
      const result = validateVerifyRequest({ ...validBody, meta_hint: 'x' });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const err = result.errors.find((e) => e.field === 'meta_hint');
        // Message includes the allowed set so the caller can self-correct without docs.
        expect(err!.message).toContain('Allowed:');
        expect(err!.message).toContain('claim');
        expect(err!.message).toContain('evidence');
      }
    });
  });

  // ------------------------------------------------------------
  // ADR-0020: action_hash + required_conditions validation
  // ------------------------------------------------------------
  describe('ADR-0020 structured fields', () => {
    const goodHash = '0x' + 'ab'.repeat(32);
    const goodCondition = {
      condition_id: 'alpha_required',
      required: true,
      proof_requirement: 'machine',
      evidence_bindings: [
        {
          evidence_id: 'evidence:alpha_ok',
          bound_condition_id: 'alpha_required',
          syntactically_valid: true,
          freshness: 'fresh',
          contradicted: false,
          grade: 'machine',
        },
      ],
    };

    it('accepts canonical action_hash and lowercases it', () => {
      const upper = '0x' + 'AB'.repeat(32);
      const result = validateVerifyRequest({ ...validBody, action_hash: upper });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.action_hash).toBe(upper.toLowerCase());
      }
    });

    it('rejects free-text action_hash (PII / secret guard)', () => {
      const result = validateVerifyRequest({
        ...validBody,
        action_hash: 'user@example.com secret-token',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const err = result.errors.find((e) => e.field === 'action_hash');
        expect(err).toBeDefined();
        expect(err!.message).toMatch(/0x.*64 hex/i);
      }
    });

    it('rejects short / malformed action_hash', () => {
      for (const bad of ['0xabc', 'ab'.repeat(32), '0x' + 'g'.repeat(64), '', '  ']) {
        const result = validateVerifyRequest({ ...validBody, action_hash: bad });
        expect(result.valid).toBe(false);
      }
    });

    it('accepts well-formed required_conditions', () => {
      const result = validateVerifyRequest({
        ...validBody,
        action_hash: goodHash,
        required_conditions: [goodCondition],
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.required_conditions).toHaveLength(1);
        expect(result.data.required_conditions![0].condition_id).toBe('alpha_required');
        expect(result.data.required_conditions![0].evidence_bindings).toHaveLength(1);
      }
    });

    it('rejects duplicate condition_id', () => {
      const result = validateVerifyRequest({
        ...validBody,
        required_conditions: [
          goodCondition,
          { ...goodCondition, condition_id: 'alpha_required' },
        ],
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.message.includes('duplicate'))).toBe(true);
      }
    });

    it('rejects unknown nested fields on conditions and bindings', () => {
      const result = validateVerifyRequest({
        ...validBody,
        required_conditions: [
          {
            ...goodCondition,
            sneaky: true,
            evidence_bindings: [
              {
                ...goodCondition.evidence_bindings[0],
                raw_secret: 'leak-me',
              },
            ],
          },
        ],
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const fields = result.errors.map((e) => e.field);
        expect(fields).toContain('required_conditions[0].sneaky');
        expect(fields).toContain('required_conditions[0].evidence_bindings[0].raw_secret');
      }
    });

    it('rejects valid_bound_evidence_count (untrusted caller count)', () => {
      const result = validateVerifyRequest({
        ...validBody,
        required_conditions: [
          {
            ...goodCondition,
            valid_bound_evidence_count: 99,
          },
        ],
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.errors.some((e) => e.field === 'required_conditions[0].valid_bound_evidence_count'),
        ).toBe(true);
      }
    });

    it('rejects more than 32 required_conditions', () => {
      const many = Array.from({ length: 33 }, (_, i) => ({
        condition_id: `cond_${i}`,
        required: true,
        proof_requirement: 'machine',
      }));
      const result = validateVerifyRequest({ ...validBody, required_conditions: many });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.field === 'required_conditions')).toBe(true);
      }
    });

    it('rejects more than 16 bindings per condition', () => {
      const bindings = Array.from({ length: 17 }, (_, i) => ({
        evidence_id: `evidence:b_${i}`,
        bound_condition_id: 'alpha_required',
        syntactically_valid: true,
        freshness: 'fresh',
        contradicted: false,
        grade: 'machine',
      }));
      const result = validateVerifyRequest({
        ...validBody,
        required_conditions: [{ ...goodCondition, evidence_bindings: bindings }],
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.errors.some((e) => e.field === 'required_conditions[0].evidence_bindings'),
        ).toBe(true);
      }
    });
  });
});
