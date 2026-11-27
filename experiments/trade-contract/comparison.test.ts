import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildAdapterMessages } from './messages.ts';
import { caseById, casesFor, COMPARISON_CASES } from './comparison-cases.ts';
import { scoreComparison, type ArmRun } from './comparison-evaluate.ts';
import { prepareModelContent, validGrounding } from './comparison-grounding.ts';
import { SEALED_LABELS, labelsFor } from './comparison-labels.ts';
import { mechanicalOutput } from './comparison-mechanical.ts';
import { paidPilotRefusalReason, runPaidPilot, sendPaidExchange, usdFromXaiTicks, XAI_USD_TICKS } from './comparison-paid.ts';
import { deterministicPrecheckPasses } from './comparison-precheck.ts';
import { ARM_B_APPENDIX, COMPARISON_BASELINE, SHARED_APPENDIX, armSystemPrompt } from './comparison-prompt.ts';
import { PER_CASE_BUDGET_MS, PROPOSED_PILOT_COST_CAP_USD, createSpendLedger, exceedsCostCap, maxCallCostUsd } from './comparison-budget.ts';
import { pilotPlan, schemaSmokePlan } from './comparison-plan.ts';
import { buildArmRequest, replayLegacyDrop, runRecordedArm } from './comparison-run.ts';
import { bookCallCost, nextCallExceedsSoftCap, runSchemaSmoke, SCHEMA_SMOKE_PAID, SCHEMA_SMOKE_SOFT_CAP_NOTE } from './comparison-smoke.ts';
import { armCaseRow, dev06AllowBlocker } from './comparison-report.ts';
import { PROMPT_TEMPLATE } from './prompt.ts';

function source(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
}

function pilotPayload(caseId: string, arm: 'A' | 'B' = 'A'): string {
  return buildArmRequest(caseById(caseId).documents, arm).messages[1].content;
}

function contradictedPilot01(): string {
  const item = caseById('pilot-01');
  const mandate = item.documents.find(document => document.id === 'mandate')!.text;
  return mechanicalOutput({
    documents: item.documents,
    proposalQuote: 'Pay 250 EUR to Northwind for invoice INV-100.',
    sourceQuote: 'Goods received.',
    mandateQuote: mandate,
    extra: {
      id: 'second-approval',
      documentId: 'invoice',
      quote: 'Second approval for INV-100 is pending.',
    },
    mandateStatus: 'contradicted',
    grounding: [{
      objectionId: 'stated-mandate',
      clauseDocumentId: 'mandate',
      clauseQuote: mandate,
      evidenceDocumentId: 'invoice',
      evidenceQuote: 'Goods received.',
      reading: 'met',
    }],
  });
}

describe('comparison prompts', () => {
  it('adds one paragraph on arm B and shares the missing-evidence instruction', () => {
    const armA = armSystemPrompt('A');
    const armB = armSystemPrompt('B');
    expect(armA.startsWith(PROMPT_TEMPLATE)).toBe(true);
    expect(armB.startsWith(PROMPT_TEMPLATE)).toBe(true);
    expect(armA).toContain(SHARED_APPENDIX);
    expect(armB).toContain(SHARED_APPENDIX);
    expect(armA).not.toContain(ARM_B_APPENDIX);
    expect(armB).toBe(`${armA}\n${ARM_B_APPENDIX}`);
  });

  it('builds the same request for both arms except that paragraph', () => {
    const documents = caseById('pilot-01').documents;
    const armA = buildArmRequest(documents, 'A');
    const armB = buildArmRequest(documents, 'B');
    expect(armA.model).toBe('grok-4.7');
    expect(armA.reasoning_effort).toBe('low');
    expect(armA.temperature).toBe(armB.temperature);
    expect(armA.seed).toBe(armB.seed);
    expect(armA.max_completion_tokens).toBe(armB.max_completion_tokens);
    expect(armA.response_format).toEqual(armB.response_format);
    expect(armA.messages[1]).toEqual(armB.messages[1]);
    expect(armA.messages[1]).toEqual(buildAdapterMessages(documents)[1]);
    expect(armB.messages[0].content).toBe(`${armA.messages[0].content}\n${ARM_B_APPENDIX}`);
    expect(source('comparison-prompt.ts')).toContain(COMPARISON_BASELINE);
    expect(source('COMPARISON.md')).toContain(COMPARISON_BASELINE);
    expect(source('README.md')).toContain(COMPARISON_BASELINE);
    expect(armA).not.toHaveProperty('tools');
    expect(armB).not.toHaveProperty('tools');
  });

  it('keeps pair ids, counterparts, and sealed labels out of the payload', () => {
    for (const item of COMPARISON_CASES) {
      for (const arm of ['A', 'B'] as const) {
        const payload = pilotPayload(item.caseId, arm);
        const parsed = JSON.parse(payload) as { id: string; role: string; text: string }[];
        expect(parsed.every(row => Object.keys(row).sort().join() === 'id,role,text')).toBe(true);
        for (const label of SEALED_LABELS) {
          expect(payload).not.toContain(label.rationale);
          expect(payload).not.toContain(label.caseId);
        }
        expect(payload).not.toContain('SEALED:');
        expect(payload).not.toContain('pairId');
        expect(payload).not.toContain('counterpart');
        expect(payload).not.toContain('expected');
      }
    }
    const left = caseById('pilot-01');
    const right = caseById('pilot-02');
    const leftMandate = left.documents.find(document => document.id === 'mandate')!.text;
    const rightMandate = right.documents.find(document => document.id === 'mandate')!.text;
    expect(pilotPayload('pilot-01')).not.toContain(rightMandate);
    expect(pilotPayload('pilot-02')).not.toContain(leftMandate);
    expect(pilotPayload('pilot-03')).toContain('Invoice INV-200 from Contoso for 100 EUR.');
    expect(pilotPayload('pilot-04')).not.toContain('Invoice INV-200 from Contoso for 100 EUR.');
    expect(pilotPayload('pilot-05')).not.toContain('Shipping invoice SH-10 from Fabrikam for 80 EUR.');
    expect(pilotPayload('pilot-06')).not.toContain('Shipping invoice SH-9 from Fabrikam for 80 EUR.');
  });

  it('does not import sealed labels from the prompt, cases, or gate path', () => {
    for (const name of ['comparison-prompt.ts', 'comparison-cases.ts', 'comparison-run.ts', 'comparison-grounding.ts']) {
      expect(source(name)).not.toContain('comparison-labels');
    }
  });
});

describe('deterministic pre-checks', () => {
  it('passes every pilot and development case', () => {
    expect(casesFor('pilot')).toHaveLength(6);
    expect(casesFor('dev')).toHaveLength(6);
    for (const item of COMPARISON_CASES) {
      expect(deterministicPrecheckPasses(item.precheck)).toBe(true);
    }
  });

  it('keeps development texts disjoint from pilot texts', () => {
    const pilot = new Set(casesFor('pilot').flatMap(item => item.documents.map(document => document.text)));
    for (const text of casesFor('dev').flatMap(item => item.documents.map(document => document.text))) {
      expect(pilot.has(text)).toBe(false);
    }
  });

  it('rejects an amount overshoot, a recipient mismatch, and an unlimited allowance', () => {
    const base = caseById('pilot-01').precheck;
    expect(deterministicPrecheckPasses({ ...base, actionAmount: 10_000 })).toBe(false);
    expect(deterministicPrecheckPasses({ ...base, actionRecipient: 'Other' })).toBe(false);
    expect(deterministicPrecheckPasses({ ...base, allowance: '1e40' })).toBe(false);
  });
});

describe('sealed labels', () => {
  it('matches the case list and was fixed as ALLOW or non-ALLOW', () => {
    expect(SEALED_LABELS.map(label => label.caseId)).toEqual(COMPARISON_CASES.map(item => item.caseId));
    for (const label of SEALED_LABELS) {
      expect(label.justified).toBe(label.expected === 'ALLOW');
      expect(label.split).toBe(caseById(label.caseId).split);
      expect(label.rationale.startsWith('SEALED:')).toBe(true);
    }
  });

  it('keeps the six pilot cases and labels byte-identical to 832cedf', () => {
    const body = JSON.stringify({
      cases: casesFor('pilot').map(item => ({
        caseId: item.caseId, split: item.split, documents: item.documents, precheck: item.precheck,
      })),
      labels: labelsFor('pilot'),
    });
    expect(createHash('sha256').update(body).digest('hex'))
      .toBe('1b871537bda376df9eb3f0b40d0c1f20a1565a693a9c88828965965550fb4a6c');
  });
});

describe('grounding drop and the public gate', () => {
  it('lets a changed objection status change ALLOW and BLOCK when the payload is schema-valid', () => {
    const item = caseById('pilot-01');
    const mandate = item.documents.find(document => document.id === 'mandate')!.text;
    const fulfilled = mechanicalOutput({
      documents: item.documents,
      proposalQuote: 'Pay 250 EUR to Northwind for invoice INV-100.',
      sourceQuote: 'Goods received.',
      mandateQuote: mandate,
      mandateStatus: 'fulfilled',
      grounding: null,
    });
    const allow = runRecordedArm({
      arm: 'A', caseId: item.caseId, documents: item.documents,
      recorded: { exchange: { ok: true, content: fulfilled }, latencyMs: 10 },
      costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
    });
    expect(allow.schemaFailure).toBe(false);
    expect(allow.publicVerdict).toBe('ALLOW');

    const content = contradictedPilot01();
    const armA = runRecordedArm({
      arm: 'A', caseId: item.caseId, documents: item.documents,
      recorded: { exchange: { ok: true, content }, latencyMs: 10 },
      costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
    });
    const armB = runRecordedArm({
      arm: 'B', caseId: item.caseId, documents: item.documents,
      recorded: { exchange: { ok: true, content }, latencyMs: 10 },
      costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
    });
    expect(armA.publicVerdict).toBe('BLOCK');
    expect(armB.publicVerdict).toBe(armA.publicVerdict);
    expect(armB.droppedIds).toEqual([]);
    const replay = replayLegacyDrop({
      arm: 'B', caseId: item.caseId, documents: item.documents, content,
    });
    expect(replay.technicalCode).toBe('legacy-drop-replay');
    expect(replay.droppedIds).toContain('second-approval');
    expect(replay.publicVerdict).toBe('ALLOW');
  });

  it('forces UNCERTAIN when complete is false, which is the downgrade floor', () => {
    const item = caseById('pilot-01');
    const mandate = item.documents.find(document => document.id === 'mandate')!.text;
    const content = mechanicalOutput({
      documents: item.documents,
      proposalQuote: 'Pay 250 EUR to Northwind for invoice INV-100.',
      sourceQuote: 'Goods received.',
      mandateQuote: mandate,
      mandateStatus: 'fulfilled',
      complete: false,
      grounding: null,
    });
    const run = runRecordedArm({
      arm: 'A', caseId: item.caseId, documents: item.documents,
      recorded: { exchange: { ok: true, content }, latencyMs: 10 },
      costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
    });
    expect(run.schemaFailure).toBe(false);
    expect(run.publicVerdict).toBe('UNCERTAIN');
  });

  it('drops an ungrounded clause and keeps a violated clause', () => {
    const documents = caseById('pilot-02').documents;
    const mandate = documents.find(document => document.id === 'mandate')!.text;
    const pending = 'Second approval for INV-100 is pending.';
    expect(validGrounding({
      objectionId: 'second',
      clauseDocumentId: 'invoice',
      clauseQuote: pending,
      evidenceDocumentId: 'invoice',
      evidenceQuote: pending,
      reading: 'violated',
    }, documents)).toBe(false);
    expect(validGrounding({
      objectionId: 'second',
      clauseDocumentId: 'mandate',
      clauseQuote: mandate,
      evidenceDocumentId: 'invoice',
      evidenceQuote: pending,
      reading: 'violated',
    }, documents)).toBe(true);
    const content = mechanicalOutput({
      documents,
      proposalQuote: 'Pay 250 EUR to Northwind for invoice INV-100.',
      sourceQuote: 'Goods received.',
      mandateQuote: mandate,
      mandateStatus: 'contradicted',
      grounding: [{
        objectionId: 'stated-mandate',
        clauseDocumentId: 'mandate',
        clauseQuote: mandate,
        evidenceDocumentId: 'invoice',
        evidenceQuote: pending,
        reading: 'violated',
      }],
    });
    const run = runRecordedArm({
      arm: 'B', caseId: 'pilot-02', documents,
      recorded: { exchange: { ok: true, content }, latencyMs: 20 },
      costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
    });
    expect(run.droppedIds).not.toContain('stated-mandate');
    expect(run.publicVerdict).toBe('BLOCK');
  });

  it('maps an open grounded condition to UNCERTAIN', () => {
    const documents = caseById('pilot-04').documents;
    const mandate = documents.find(document => document.id === 'mandate')!.text;
    const content = mechanicalOutput({
      documents,
      proposalQuote: 'Pay 100 EUR to Contoso for invoice INV-200.',
      sourceQuote: mandate,
      mandateQuote: mandate,
      mandateStatus: 'contradicted',
      grounding: [{
        objectionId: 'stated-mandate',
        clauseDocumentId: 'mandate',
        clauseQuote: mandate,
        evidenceDocumentId: 'mandate',
        evidenceQuote: mandate,
        reading: 'open',
      }],
    });
    const prepared = prepareModelContent(content, documents, 'primary');
    expect(prepared.schemaFailure).toBe(false);
    const openContent = mechanicalOutput({
      documents,
      proposalQuote: 'Pay 100 EUR to Contoso for invoice INV-200.',
      sourceQuote: mandate,
      mandateQuote: mandate,
      mandateStatus: 'fulfilled',
      grounding: [{
        objectionId: 'stated-mandate',
        clauseDocumentId: 'mandate',
        clauseQuote: mandate,
        evidenceDocumentId: null,
        evidenceQuote: null,
        reading: 'open',
      }],
    });
    for (const arm of ['A', 'B'] as const) {
      const run = runRecordedArm({
        arm, caseId: 'pilot-04', documents,
        recorded: { exchange: { ok: true, content: openContent }, latencyMs: 5 },
        costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
      });
      expect(run.schemaFailure).toBe(false);
      expect(run.publicVerdict).toBe('UNCERTAIN');
    }
  });

  it('treats invalid JSON as a schema failure and UNCERTAIN for both arms', () => {
    for (const arm of ['A', 'B'] as const) {
      const run = runRecordedArm({
        arm, caseId: 'pilot-01', documents: caseById('pilot-01').documents,
        recorded: { exchange: { ok: true, content: '{not json' }, latencyMs: 1 },
        costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
      });
      expect(run.schemaFailure).toBe(true);
      expect(run.publicVerdict).toBe('UNCERTAIN');
    }
  });
});

describe('budget, timeout, and cost cap', () => {
  it('uses one 45 second budget and withholds ALLOW past it', () => {
    expect(PER_CASE_BUDGET_MS).toBe(45_000);
    const content = contradictedPilot01();
    const within = runRecordedArm({
      arm: 'A', caseId: 'pilot-01', documents: caseById('pilot-01').documents,
      recorded: { exchange: { ok: true, content }, latencyMs: PER_CASE_BUDGET_MS },
      costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
    });
    const over = runRecordedArm({
      arm: 'B', caseId: 'pilot-01', documents: caseById('pilot-01').documents,
      recorded: { exchange: { ok: true, content }, latencyMs: PER_CASE_BUDGET_MS + 1 },
      costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
    });
    expect(within.outcome).toBe('verdict');
    expect(over.outcome).toBe('timeout');
    expect(over.publicVerdict).toBeNull();
    const timedOut = runRecordedArm({
      arm: 'A', caseId: 'pilot-01', documents: caseById('pilot-01').documents,
      recorded: { exchange: { ok: false, reason: 'timeout' }, latencyMs: 1 },
      costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
    });
    expect(timedOut.outcome).toBe('timeout');
    const transport = runRecordedArm({
      arm: 'B', caseId: 'pilot-01', documents: caseById('pilot-01').documents,
      recorded: { exchange: { ok: false, reason: 'transport_error' }, latencyMs: 1 },
      costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
    });
    expect(transport.outcome).toBe('technical_error');
    expect(transport.technicalCode).toBe('transport_error');
  });

  it('applies the same cost cap to both arms', () => {
    expect(exceedsCostCap(PROPOSED_PILOT_COST_CAP_USD, PROPOSED_PILOT_COST_CAP_USD)).toBe(false);
    expect(exceedsCostCap(PROPOSED_PILOT_COST_CAP_USD + 0.01, PROPOSED_PILOT_COST_CAP_USD)).toBe(true);
    const documents = caseById('pilot-01').documents;
    const content = contradictedPilot01();
    const over = runRecordedArm({
      arm: 'B', caseId: 'pilot-01', documents,
      recorded: { exchange: { ok: true, content }, latencyMs: 1, usageUsd: 6 },
      costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
    });
    const under = runRecordedArm({
      arm: 'A', caseId: 'pilot-01', documents,
      recorded: { exchange: { ok: true, content }, latencyMs: 1, usageUsd: 1 },
      costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
    });
    expect(over.outcome).toBe('technical_error');
    expect(over.technicalCode).toBe('cost_cap');
    expect(under.outcome).toBe('verdict');
  });

  it('does not call fetch when the paid pilot is refused', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('fetch should not run');
    });
    const result = await sendPaidExchange({
      env: {},
      body: { model: 'grok-4.7' },
      timeoutMs: PER_CASE_BUDGET_MS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(paidPilotRefusalReason({})).toBe('GROUNDED_CRITIC_ALLOW_PAID is not 1');
    expect(result).toEqual({ ok: false, reason: 'transport_error' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('evaluator counts', () => {
  function row(partial: Partial<ArmRun> & Pick<ArmRun, 'arm' | 'caseId' | 'publicVerdict'>): ArmRun {
    return {
      outcome: 'verdict',
      preGateVerdict: partial.publicVerdict,
      latencyMs: 10,
      schemaFailure: false,
      droppedIds: [],
      technicalCode: null,
      ...partial,
    };
  }

  it('counts only-B ALLOW, false ALLOW, and records the pre-gate judgment', () => {
    const labels = labelsFor('pilot');
    const rows: ArmRun[] = [
      row({ arm: 'A', caseId: 'pilot-01', publicVerdict: 'BLOCK', preGateVerdict: 'BLOCK' }),
      row({ arm: 'B', caseId: 'pilot-01', publicVerdict: 'ALLOW', preGateVerdict: 'BLOCK' }),
      row({ arm: 'A', caseId: 'pilot-03', publicVerdict: 'ALLOW', preGateVerdict: 'ALLOW' }),
      row({ arm: 'B', caseId: 'pilot-03', publicVerdict: 'ALLOW', preGateVerdict: 'ALLOW' }),
      row({ arm: 'A', caseId: 'pilot-05', publicVerdict: 'UNCERTAIN', preGateVerdict: 'UNCERTAIN' }),
      row({ arm: 'B', caseId: 'pilot-05', publicVerdict: 'BLOCK', preGateVerdict: 'BLOCK' }),
      row({ arm: 'A', caseId: 'pilot-02', publicVerdict: 'BLOCK', preGateVerdict: 'BLOCK' }),
      row({ arm: 'B', caseId: 'pilot-02', publicVerdict: 'ALLOW', preGateVerdict: 'BLOCK' }),
      row({ arm: 'A', caseId: 'pilot-04', publicVerdict: 'UNCERTAIN', preGateVerdict: 'UNCERTAIN' }),
      row({ arm: 'B', caseId: 'pilot-04', publicVerdict: 'UNCERTAIN', preGateVerdict: 'UNCERTAIN' }),
      row({ arm: 'A', caseId: 'pilot-06', publicVerdict: 'ALLOW', preGateVerdict: 'ALLOW' }),
      row({ arm: 'B', caseId: 'pilot-06', publicVerdict: 'BLOCK', preGateVerdict: 'BLOCK' }),
    ];
    const score = scoreComparison(rows, labels);
    expect(score.justified.onlyBCorrectAllow).toBe(1);
    expect(score.justified.onlyACorrectAllow).toBe(0);
    expect(score.justified.bothAllow).toBe(1);
    expect(score.justified.neitherAllow).toBe(1);
    expect(score.unjustifiedFalseAllow).toEqual({ onlyB: 1, onlyA: 1, both: 0 });
    expect(score.ceilingEffect).toBe(false);
    expect(score.divergent.map(item => item.caseId)).toEqual(['pilot-01', 'pilot-02', 'pilot-05', 'pilot-06']);
    expect(score.divergent[0]).toMatchObject({ preGateB: 'BLOCK', publicB: 'ALLOW' });
    expect(score.block).toBe(4);
    expect(score.uncertain).toBe(3);
  });

  it('names the ceiling when arm A already allows every justified case', () => {
    const labels = labelsFor('pilot').filter(label => label.justified);
    const rows = labels.flatMap(label => ([
      row({ arm: 'A' as const, caseId: label.caseId, publicVerdict: 'ALLOW' as const }),
      row({ arm: 'B' as const, caseId: label.caseId, publicVerdict: 'BLOCK' as const }),
    ]));
    expect(scoreComparison(rows, labels).ceilingEffect).toBe(true);
    expect(scoreComparison(rows, labels).justified.onlyACorrectAllow).toBe(labels.length);
  });

  it('counts timeouts and technical errors apart from verdicts', () => {
    const labels = labelsFor('dev').filter(label => label.caseId === 'dev-01');
    const rows: ArmRun[] = [
      row({ arm: 'A', caseId: 'dev-01', publicVerdict: null, outcome: 'timeout', latencyMs: 45_001 }),
      row({ arm: 'B', caseId: 'dev-01', publicVerdict: null, outcome: 'technical_error', technicalCode: 'http_error' }),
    ];
    const score = scoreComparison(rows, labels);
    expect(score.timeouts).toBe(1);
    expect(score.technicalErrors).toBe(1);
    expect(score.justified.neitherAllow).toBe(1);
    expect(score.block).toBe(0);
    expect(score.uncertain).toBe(0);
    expect(score.latencyMs).toEqual({ A: [45_001], B: [10] });
  });
});

describe('dev quote regression', () => {
  function releaseAttempt(evidenceDocumentId: string | null, evidenceQuote: string | null, reading: 'met' | 'open' = 'met'): string {
    const documents = caseById('dev-05').documents;
    const mandate = documents.find(document => document.id === 'mandate')!.text;
    return mechanicalOutput({
      documents,
      proposalQuote: 'Pay 250 EUR to Harbor Co for invoice INV-440.',
      sourceQuote: 'Invoice INV-440 from Harbor Co for 250 EUR.',
      mandateQuote: mandate,
      mandateStatus: 'fulfilled',
      grounding: [{
        objectionId: 'stated-mandate',
        clauseDocumentId: 'mandate',
        clauseQuote: mandate,
        evidenceDocumentId,
        evidenceQuote,
        reading,
      }],
    });
  }

  it('never ALLOWs a pending second approval, whatever the quote quality', () => {
    const documents = caseById('dev-05').documents;
    const variants = [
      releaseAttempt(null, null),
      releaseAttempt('invoice', 'Second approval was granted yesterday.'),
      releaseAttempt('invoice', 'Goods were received.'),
      releaseAttempt('invoice', 'Second approval for INV-440 is still pending.'),
      releaseAttempt(null, null, 'open'),
    ];
    for (const content of variants) {
      for (const arm of ['A', 'B'] as const) {
        const run = runRecordedArm({
          arm, caseId: 'dev-05', documents,
          recorded: { exchange: { ok: true, content }, latencyMs: 3 },
          costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
        });
        expect(run.publicVerdict).not.toBe('ALLOW');
        expect(run.publicVerdict).toBe(runRecordedArm({
          arm: arm === 'A' ? 'B' : 'A', caseId: 'dev-05', documents,
          recorded: { exchange: { ok: true, content }, latencyMs: 3 },
          costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
        }).publicVerdict);
      }
    }
  });

  it('ALLOWs the justified counterpart when the quote supports the real clause', () => {
    const documents = caseById('dev-06').documents;
    const mandate = documents.find(document => document.id === 'mandate')!.text;
    const content = mechanicalOutput({
      documents,
      proposalQuote: 'Pay 250 EUR to Harbor Co for invoice INV-440.',
      sourceQuote: 'Invoice INV-440 from Harbor Co for 250 EUR.',
      mandateQuote: mandate,
      mandateStatus: 'fulfilled',
      grounding: [{
        objectionId: 'stated-mandate',
        clauseDocumentId: 'mandate',
        clauseQuote: mandate,
        evidenceDocumentId: 'invoice',
        evidenceQuote: 'Invoice INV-440 from Harbor Co for 250 EUR.',
        reading: 'met',
      }],
    });
    for (const arm of ['A', 'B'] as const) {
      const run = runRecordedArm({
        arm, caseId: 'dev-06', documents,
        recorded: { exchange: { ok: true, content }, latencyMs: 3 },
        costCapUsd: PROPOSED_PILOT_COST_CAP_USD,
      });
      expect(run.publicVerdict).toBe('ALLOW');
    }
  });
});

describe('schema smoke and spend reservation', () => {
  it('plans schema smoke on dev cases only', () => {
    const smoke = schemaSmokePlan();
    const pilot = pilotPlan();
    expect(smoke.caseIds.every(id => id.startsWith('dev-'))).toBe(true);
    expect(smoke.caseIds.some(id => id.startsWith('pilot-'))).toBe(false);
    expect(smoke.maxCalls).toBe(casesFor('dev').length * 2);
    expect(pilot.maxCalls).toBe(12);
    expect(pilot.caseIds).toEqual(['pilot-01', 'pilot-02', 'pilot-03', 'pilot-04', 'pilot-05', 'pilot-06']);
    expect(smoke.baseline).toBe(COMPARISON_BASELINE);
  });

  it('never sends a pilot case during schema smoke', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"not":"adapter"}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 400 });
    });
    const report = await runSchemaSmoke({
      GROUNDED_CRITIC_ALLOW_PAID: '1',
      GROUNDED_CRITIC_COST_CAP_USD: '100',
      XAI_API_KEY: 'test-key',
    }, fetchImpl as unknown as typeof fetch);
    expect(report.caseIds.every(id => id.startsWith('dev-'))).toBe(true);
    expect(bodies.length).toBe(report.maxCalls);
    const joined = bodies.join('\n');
    expect(joined).not.toContain('pilot-01');
    expect(joined).not.toContain('Northwind');
    expect(joined).not.toContain('INV-100');
    expect(report.providerOrSchemaErrors).toBe(bodies.length);
    expect(report.frozenValidatorRejections).toBe(0);
    expect(report.substantiveUncertain).toBe(0);
  });

  it('counts provider errors, frozen-validator rejections, and substantive UNCERTAIN apart', async () => {
    const open = (() => {
      const documents = caseById('dev-05').documents;
      const mandate = documents.find(document => document.id === 'mandate')!.text;
      return mechanicalOutput({
        documents,
        proposalQuote: 'Pay 250 EUR to Harbor Co for invoice INV-440.',
        sourceQuote: 'Invoice INV-440 from Harbor Co for 250 EUR.',
        mandateQuote: mandate,
        mandateStatus: 'fulfilled',
        grounding: [{
          objectionId: 'stated-mandate',
          clauseDocumentId: 'mandate',
          clauseQuote: mandate,
          evidenceDocumentId: null,
          evidenceQuote: null,
          reading: 'open',
        }],
      });
    })();
    let n = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      n += 1;
      const body = String(init?.body ?? '');
      if (n === 1) return new Response('no', { status: 500 });
      if (body.includes('dev-05') || body.includes('only after a recorded second approval')) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: open } }],
          usage: { prompt_tokens: 2, completion_tokens: 2 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }), { status: 200 });
    });
    const report = await runSchemaSmoke({
      GROUNDED_CRITIC_ALLOW_PAID: '1',
      GROUNDED_CRITIC_COST_CAP_USD: '100',
      XAI_API_KEY: 'test-key',
    }, fetchImpl as unknown as typeof fetch);
    expect(report.providerOrSchemaErrors).toBeGreaterThan(0);
    expect(report.frozenValidatorRejections).toBeGreaterThan(0);
    expect(report.substantiveUncertain).toBeGreaterThan(0);
    expect(report.providerOrSchemaErrors + report.frozenValidatorRejections + report.substantiveUncertain)
      .toBeLessThanOrEqual(report.calls);
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows[0]).toEqual(expect.objectContaining({
      caseId: expect.any(String),
      arm: expect.stringMatching(/^[AB]$/),
      providerStatus: expect.any(String),
      parserResult: expect.any(String),
      firstAllowBlocker: expect.any(String),
    }));
  });

  it('classifies one invalid claim as a frozen-parser schema_violation, not substantive UNCERTAIN', () => {
    const documents = caseById('dev-06').documents;
    const mandate = documents.find(document => document.id === 'mandate')!.text;
    const raw = JSON.parse(mechanicalOutput({
      documents,
      proposalQuote: 'Pay 250 EUR to Harbor Co for invoice INV-440.',
      sourceQuote: 'Invoice INV-440 from Harbor Co for 250 EUR.',
      mandateQuote: mandate,
      mandateStatus: 'fulfilled',
      grounding: null,
    })) as { claims: unknown[]; grounding?: unknown };
    delete raw.grounding;
    raw.claims = [{
      id: 'bad-claim',
      kind: 'bogus',
      status: 'fulfilled',
      claimQuote: { documentId: 'proposal', quote: 'Pay 250 EUR to Harbor Co for invoice INV-440.' },
      supportingQuotes: [],
      calculation: null,
    }];
    const row = armCaseRow({
      caseId: 'dev-06',
      arm: 'A',
      providerStatus: 'ok',
      documents,
      content: JSON.stringify(raw),
    });
    expect(row.parserResult).toBe('schema_violation');
    expect(row.countsAs).toBe('validator_rejection');
    expect(row.countsAs).not.toBe('substantive_uncertain');
    expect(row.frozenGateVerdict).toBe('UNCERTAIN');
    expect(row.firstAllowBlocker).toBe('parser:schema_violation');
    const twin = armCaseRow({
      caseId: 'dev-06',
      arm: 'B',
      providerStatus: 'ok',
      documents,
      content: JSON.stringify(raw),
    });
    const note = dev06AllowBlocker([row, twin]);
    expect(note.bothUncertain).toBe(true);
    expect(note.firstAllowBlocker).toContain('parser:schema_violation');
  });

  it('names the grounding follow-up when that is the first step that blocks ALLOW', () => {
    const documents = caseById('dev-06').documents;
    const mandate = documents.find(document => document.id === 'mandate')!.text;
    const content = mechanicalOutput({
      documents,
      proposalQuote: 'Pay 250 EUR to Harbor Co for invoice INV-440.',
      sourceQuote: 'Invoice INV-440 from Harbor Co for 250 EUR.',
      mandateQuote: mandate,
      mandateStatus: 'fulfilled',
      grounding: [{
        objectionId: 'stated-mandate',
        clauseDocumentId: 'mandate',
        clauseQuote: mandate,
        evidenceDocumentId: null,
        evidenceQuote: null,
        reading: 'open',
      }],
    });
    const row = armCaseRow({
      caseId: 'dev-06', arm: 'A', providerStatus: 'ok', documents, content,
    });
    expect(row.parserResult).toBe('ok');
    expect(row.frozenGateVerdict).toBe('ALLOW');
    expect(row.publicVerdict).toBe('UNCERTAIN');
    expect(row.firstAllowBlocker).toBe('grounding_follow_up');
    expect(row.countsAs).toBe('substantive_uncertain');
  });

  it('converts xAI cost ticks and keeps the smoke soft-cap constraints', () => {
    expect(XAI_USD_TICKS).toBe(10_000_000_000);
    expect(usdFromXaiTicks(37_756_000)).toBeCloseTo(0.0037756);
    expect(usdFromXaiTicks(1.5)).toBeNull();
    expect(SCHEMA_SMOKE_PAID).toEqual({ maxCalls: 12, timeoutMs: 45_000, retries: 0, budgetUsd: 1 });
    expect(SCHEMA_SMOKE_SOFT_CAP_NOTE).toContain('single call may exceed');
    expect(source('comparison-offline.ts')).toContain('SCHEMA_SMOKE_SOFT_CAP_NOTE');
    expect(source('comparison-offline.ts')).toContain('keyOnly: true');
  });

  it('aborts before the next call when actual cost plus the next estimate exceeds 1 USD', async () => {
    expect(bookCallCost(null, 0.6)).toBeCloseTo(0.6);
    expect(bookCallCost(null, 0.6)).not.toBe(0);
    expect(bookCallCost(0, 0.6)).toBe(0);
    expect(nextCallExceedsSoftCap(0.6, 0.5, 1)).toBe(true);
    expect(nextCallExceedsSoftCap(0.6, 0.4, 1)).toBe(false);
    expect(nextCallExceedsSoftCap(0, 1.01, 1)).toBe(true);

    const documents = caseById('dev-01').documents;
    const request = buildArmRequest(documents, 'A');
    const estimate = maxCallCostUsd(JSON.stringify(request), request.max_completion_tokens);
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      expect(String(init?.body ?? '')).not.toContain('pilot-01');
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{}' } }],
      }), { status: 200 });
    });
    const report = await runSchemaSmoke({ XAI_API_KEY: 'test-key' }, fetchImpl as unknown as typeof fetch, {
      softCapUsd: estimate * 1.5,
      timeoutMs: SCHEMA_SMOKE_PAID.timeoutMs,
      maxCalls: SCHEMA_SMOKE_PAID.maxCalls,
      keyOnly: true,
    });
    expect(calls).toBe(1);
    expect(report.calls_sent).toBe(1);
    expect(report.cumulativeCostUsd).toBeCloseTo(estimate);
    expect(report.rows.some(row => row.providerStatus === 'not_sent')).toBe(true);
    expect(report.softCapNote).toBe(SCHEMA_SMOKE_SOFT_CAP_NOTE);
  });

  it('reserves the conservative max before send and keeps it on timeout or unknown usage', async () => {
    const body = buildArmRequest(caseById('pilot-01').documents, 'A');
    const one = maxCallCostUsd(JSON.stringify(body), body.max_completion_tokens);
    const ledger = createSpendLedger(one);
    const first = ledger.tryReserve(one);
    expect(first).not.toBeNull();
    expect(ledger.tryReserve(one)).toBeNull();
    ledger.keep(first!);
    expect(ledger.booked()).toBeCloseTo(one);

    const unknown = createSpendLedger(one * 2);
    const ticket = unknown.tryReserve(one);
    expect(unknown.tryReserve(one)).not.toBeNull();
    unknown.keep(ticket!);
    expect(unknown.tryReserve(one)).toBeNull();

    const reconciled = createSpendLedger(one);
    const paid = reconciled.tryReserve(one);
    reconciled.reconcile(paid!, 0);
    expect(reconciled.tryReserve(one)).not.toBeNull();

    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('timeout');
      return new Response('{}', { status: 200 });
    });
    const runs = await runPaidPilot({
      GROUNDED_CRITIC_ALLOW_PAID: '1',
      GROUNDED_CRITIC_COST_CAP_USD: String(one),
      XAI_API_KEY: 'test-key',
    }, fetchImpl as unknown as typeof fetch);
    expect(calls).toBe(1);
    expect(runs[0].technicalCode).not.toBe('cost_cap');
    expect(runs.slice(1).every(row => row.technicalCode === 'cost_cap')).toBe(true);
  });
});
