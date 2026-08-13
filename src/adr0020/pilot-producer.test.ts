import { describe, it, expect } from 'vitest';
import {
  buildPilotVerifyRequest,
  canonicalizeActionHash,
  deriveActionHashFromStructure,
  measurementLineToPilotInput,
  PILOT_MAX_CONDITIONS,
  PILOT_PRODUCER_ID,
} from './pilot-producer.js';
import { validateVerifyRequest } from '../validation.js';

const goodHash = '0x' + 'ab'.repeat(32);

function cond(id: string, bindings: unknown[] = []) {
  return {
    condition_id: id,
    required: true,
    proof_requirement: 'machine',
    evidence_bindings: bindings,
    valid_bound_evidence_count: 99, // must be stripped
  };
}

function binding(eid: string, cid: string) {
  return {
    evidence_id: eid,
    bound_condition_id: cid,
    syntactically_valid: true,
    freshness: 'fresh',
    contradicted: false,
    grade: 'machine',
    valid_bound: true, // strip
  };
}

describe('A1 pilot producer', () => {
  it('builds valid structured request and strips untrusted counts', () => {
    const r = buildPilotVerifyRequest({
      case_id: 'MP-AND-02',
      action_hash: goodHash.toUpperCase(),
      required_conditions: [
        cond('site_deadline_met', [binding('evidence:carrier_mon_am', 'site_deadline_met')]),
        cond('depot_spare_through_window', []),
      ],
    });
    expect(r.status).toBe('ok');
    expect(r.errors).toHaveLength(0);
    expect(r.request?.action_hash).toBe(goodHash);
    expect(r.request?.required_conditions).toHaveLength(2);
    expect(r.request?.required_conditions?.[0]).not.toHaveProperty('valid_bound_evidence_count');
    expect(r.request?.required_conditions?.[0].evidence_bindings?.[0]).not.toHaveProperty(
      'valid_bound',
    );
    expect(r.meta.stripped_fields.some((s) => s.includes('valid_bound_evidence_count'))).toBe(
      true,
    );
    expect(r.request?.agent_context?.tags).toContain('caller_asserted');
    expect(r.request?.agent_context?.agent_id).toBe(PILOT_PRODUCER_ID);
    // passes server validation
    const v = validateVerifyRequest(r.request);
    expect(v.valid).toBe(true);
  });

  it('rejects missing required_conditions', () => {
    const r = buildPilotVerifyRequest({ action_hash: goodHash });
    expect(r.status).toBe('invalid');
    expect(r.errors.some((e) => e.field === 'required_conditions')).toBe(true);
    expect(r.request).toBeUndefined();
  });

  it('rejects empty required_conditions', () => {
    const r = buildPilotVerifyRequest({ action_hash: goodHash, required_conditions: [] });
    expect(r.status).toBe('invalid');
  });

  it('rejects free-text / non-canonical action_hash', () => {
    const r = buildPilotVerifyRequest({
      action_hash: 'user@example.com secret',
      required_conditions: [cond('alpha_required')],
    });
    expect(r.status).toBe('invalid');
    expect(r.errors.some((e) => e.field === 'action_hash')).toBe(true);
  });

  it('rejects unknown nested fields (tamper)', () => {
    const r = buildPilotVerifyRequest({
      action_hash: goodHash,
      required_conditions: [
        {
          ...cond('alpha_required'),
          sneaky: true,
          evidence_bindings: [{ ...binding('evidence:a_ok', 'alpha_required'), raw_secret: 'x' }],
        },
      ],
    });
    expect(r.status).toBe('invalid');
    expect(r.errors.some((e) => e.field.includes('sneaky'))).toBe(true);
    expect(r.errors.some((e) => e.field.includes('raw_secret'))).toBe(true);
  });

  it('rejects duplicate condition ids', () => {
    const r = buildPilotVerifyRequest({
      action_hash: goodHash,
      required_conditions: [cond('alpha_required'), cond('alpha_required')],
    });
    expect(r.status).toBe('invalid');
    expect(r.errors.some((e) => e.message.includes('duplicate'))).toBe(true);
  });

  it('rejects over pilot condition bound', () => {
    const many = Array.from({ length: PILOT_MAX_CONDITIONS + 1 }, (_, i) => cond(`cond_${i}`));
    const r = buildPilotVerifyRequest({ action_hash: goodHash, required_conditions: many });
    expect(r.status).toBe('invalid');
    expect(r.errors.some((e) => e.field === 'required_conditions')).toBe(true);
  });

  it('rejects secret-like claim/evidence', () => {
    const r = buildPilotVerifyRequest({
      action_hash: goodHash,
      required_conditions: [cond('alpha_required')],
      claim: 'api_key=sk-live-xxx',
      evidence: 'password=hunter2',
    });
    expect(r.status).toBe('invalid');
    expect(r.errors.some((e) => e.field === 'claim' || e.field === 'evidence')).toBe(true);
  });

  it('derives canonical hash when omitted', () => {
    const r = buildPilotVerifyRequest({
      case_id: 'DERIVE-1',
      required_conditions: [cond('alpha_required'), cond('beta_required')],
    });
    expect(r.status).toBe('ok');
    expect(r.request?.action_hash).toMatch(/^0x[a-f0-9]{64}$/);
    const again = deriveActionHashFromStructure(r.request!.required_conditions!, 'DERIVE-1');
    expect(again).toBe(r.request?.action_hash);
  });

  it('canonicalizeActionHash normalizes case and rejects junk', () => {
    expect(canonicalizeActionHash('0x' + 'AB'.repeat(32))).toBe(goodHash);
    expect(canonicalizeActionHash('nope')).toBeNull();
    expect(canonicalizeActionHash(null)).toBeNull();
  });

  it('measurementLineToPilotInput keeps structure only', () => {
    const line = {
      case_id: 'S-IM-005',
      action_hash: goodHash,
      required_conditions: [cond('a_required')],
      oracle: { gold: 'BLOCK' },
      claim: 'should not pass through',
      notes_public: 'x',
    };
    const input = measurementLineToPilotInput(line);
    expect(input.case_id).toBe('S-IM-005');
    expect(input.action_hash).toBe(goodHash);
    expect(input.required_conditions).toBeDefined();
    expect(input).not.toHaveProperty('oracle');
    expect(input.claim).toBeUndefined();
  });

  it('flag-off path: validated body has no shadow semantics fields', () => {
    const r = buildPilotVerifyRequest({
      action_hash: goodHash,
      required_conditions: [
        cond('alpha_required', [binding('evidence:alpha_ok', 'alpha_required')]),
        cond('beta_required', []),
      ],
    });
    expect(r.status).toBe('ok');
    const body = r.request!;
    expect(body).not.toHaveProperty('shadow');
    expect(body).not.toHaveProperty('would_escalate');
    const v = validateVerifyRequest(body);
    expect(v.valid).toBe(true);
    if (v.valid) {
      // server accepts; verdict path unchanged by presence of structure
      expect(v.data.required_conditions?.length).toBe(2);
      expect(v.data.action_hash).toBe(goodHash);
    }
  });
});
