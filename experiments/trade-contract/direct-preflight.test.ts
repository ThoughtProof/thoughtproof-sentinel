import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdapterRequest } from './messages.ts';
import { ARM_B_APPENDIX } from './comparison-prompt.ts';
import { buildArmRequest } from './comparison-run.ts';
import { estimatePromptTokens, PER_CASE_BUDGET_MS } from './comparison-budget.ts';
import { MODEL_CONFIG } from './model-config.ts';
import { strictBinding } from './direct-binding.ts';
import { BINDING_BUDGET_MS, bindHistorical, simulatedExecution } from './direct-historical.ts';
import {
  DUMMY_CASE_ID, DUMMY_CRITIC_ACTION, DUMMY_EVIDENCE, DUMMY_GATEWAY_PROBE, DUMMY_MANDATE, DUMMY_ORDER,
  dummyDocuments,
} from './direct-preflight-dummy.ts';

const FIX = new URL('./fixtures/direct-preflight/', import.meta.url);
const TARBALL = '/cursor/stores/self/direct-cmp-sources/gateway-vs-tp-2026-09.tgz';

function readJson(name: string) {
  return JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));
}

function criticPayload(body: { messages: { content: string }[] }) {
  const user = body.messages[1].content;
  return JSON.parse(user.slice(user.indexOf('\n') + 1)) as {
    mandate: string;
    proposed_action: string;
    reasoning: string;
    structured_world: unknown;
    structured_action: { evidence_items: { id: string; text: string }[] };
  };
}

/** One wall clock for every stage. A stage under 45s does not reset it. */
function wallClock(stages: { gateway: number; critic: number; parse: number; primary: number; secondary: number; executor: number }): number {
  return stages.gateway + stages.critic + stages.parse + stages.primary + stages.secondary + stages.executor;
}

describe('dummy preflight', () => {
  it('keeps the freeze manifest byte-identical', () => {
    const bytes = readFileSync(new URL('./direct-freeze-manifest.json', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('e591e341b04b1f339e56a34a2a592db91cfc0647b79afc094f4d11b688630f98');
  });

  it('keeps the September envelope as a secondary metric and does not execute it under strict binding', () => {
    const recorded = readJson('python-executor-trace.json') as {
      input_verdict: string;
      envelope_verdict: string;
      envelope_execute: boolean;
      raw_verdict: string;
      raw_execute: boolean;
    }[];
    expect(recorded.map(row => row.input_verdict)).toEqual(['BLOCK', 'REVIEW', 'UNCERTAIN']);
    for (const row of recorded) {
      const bound = bindHistorical({
        world: DUMMY_GATEWAY_PROBE.world,
        action: DUMMY_GATEWAY_PROBE.action,
        durationMs: 1_000,
        critic: { httpStatus: 200, execute: true, verdict: row.input_verdict },
      });
      expect(bound.criticCalled).toBe(true);
      expect(bound.decision.systemVerdict).toBe('ALLOW');
      expect(row.envelope_verdict).toBe('ALLOW');
      expect(row.envelope_execute).toBe(true);
      const strict = strictBinding({
        world: DUMMY_GATEWAY_PROBE.world,
        action: DUMMY_GATEWAY_PROBE.action,
        durationMs: 1_000,
        raw: { execute: true, verdict: row.input_verdict },
      });
      expect(strict.executed).toBe(false);
      expect(strict.protocolError).toBe('protocol_error');
      expect(strict.september).toEqual({ label: 'september_rule', verdict: 'ALLOW', execute: true });
      expect(simulatedExecution(bound.decision).executed).toBe(true);
    }
    if (!existsSync(TARBALL)) return;
    const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
    try {
      const unpacked = spawnSync('tar', ['-xzf', TARBALL, '-C', dir], { encoding: 'utf8' });
      expect(unpacked.status).toBe(0);
      const live = spawnSync('python3', [
        new URL('./direct-preflight-python.py', import.meta.url).pathname,
        join(dir, 'experiments/gateway-vs-tp-2026-09'),
        JSON.stringify({ id: DUMMY_CASE_ID, world: DUMMY_GATEWAY_PROBE.world }),
        JSON.stringify(DUMMY_GATEWAY_PROBE.action),
        JSON.stringify(['BLOCK', 'REVIEW', 'UNCERTAIN']),
      ], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir } });
      expect(live.status).toBe(0);
      expect(JSON.parse(live.stdout).rows).toEqual(recorded);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('puts the same order, mandate, and evidence in both unsent requests', () => {
    const documents = dummyDocuments();
    const primary = buildArmRequest(documents, 'B');
    const secondary = buildAdapterRequest(documents, 'secondary');
    expect(primary).toEqual(readJson('sentinel-primary.json'));
    expect(secondary).toEqual(readJson('sentinel-secondary.json'));
    expect(primary.messages[1].content).toBe(secondary.messages[1].content);
    expect(primary.messages[0].content).toContain(ARM_B_APPENDIX);
    expect(secondary.messages[0].content).not.toContain(ARM_B_APPENDIX);
    const historical = readJson('historical-critic.json') as {
      model: string;
      temperature: number;
      messages: { role: string; content: string }[];
    };
    expect(historical.model).toBe('grok-4-fast-reasoning');
    expect(historical.temperature).toBe(0.2);
    expect(historical).not.toHaveProperty('tools');
    expect(historical).not.toHaveProperty('seed');
    const payload = criticPayload(historical);
    expect(payload.proposed_action).toBe(DUMMY_ORDER);
    expect(payload.mandate).toBe(DUMMY_MANDATE);
    expect(documents.find(item => item.id === 'order')?.text).toBe(DUMMY_ORDER);
    expect(documents.find(item => item.id === 'mandate')?.text).toBe(DUMMY_MANDATE);
    expect(payload.structured_action.evidence_items).toEqual(
      DUMMY_EVIDENCE.map(item => ({ id: item.id, text: item.text })),
    );
    for (const item of DUMMY_EVIDENCE) {
      expect(documents.find(document => document.id === item.id)?.text).toBe(item.text);
      expect(payload.reasoning).toContain(item.text);
      expect(primary.messages[1].content).toContain(item.text);
      expect(historical.messages[1].content).toContain(item.text);
    }
    const sentinelKeys = Object.keys(primary).sort();
    const criticKeys = Object.keys(historical).sort();
    expect(sentinelKeys.filter(key => !criticKeys.includes(key))).toEqual([
      'max_completion_tokens', 'reasoning_effort', 'response_format', 'seed',
    ]);
    expect(criticKeys.filter(key => !sentinelKeys.includes(key))).toEqual([]);
    expect(payload.structured_world).toBeNull();
    expect(documents.every(document => document.role === 'proposal' || document.role === 'source')).toBe(true);
    expect(JSON.stringify(payload.structured_action.evidence_items)).not.toContain('"role"');
  });

  it('counts gateway, critic, parse, both cascade calls, and the executor inside one 45s clock', () => {
    expect(BINDING_BUDGET_MS).toBe(45_000);
    expect(PER_CASE_BUDGET_MS).toBe(45_000);
    const inside = wallClock({ gateway: 20, critic: 1_000, parse: 5, primary: 1_000, secondary: 1_000, executor: 1 });
    const split = wallClock({ gateway: 20, critic: 1_000, parse: 5, primary: 40_000, secondary: 6_000, executor: 1 });
    expect(inside).toBeLessThanOrEqual(45_000);
    expect(split).toBeGreaterThan(45_000);
    expect(40_000).toBeLessThanOrEqual(45_000);
    expect(6_000).toBeLessThanOrEqual(45_000);
    const allow = { httpStatus: 200, execute: true, verdict: 'ALLOW' };
    const timely = bindHistorical({
      world: DUMMY_GATEWAY_PROBE.world, action: DUMMY_GATEWAY_PROBE.action, durationMs: inside, critic: allow,
    });
    const lateSecondary = bindHistorical({
      world: DUMMY_GATEWAY_PROBE.world, action: DUMMY_GATEWAY_PROBE.action, durationMs: split, critic: allow,
    });
    expect(simulatedExecution(timely.decision).executed).toBe(true);
    expect(lateSecondary.decision.systemVerdict).toBe('ALLOW');
    expect(simulatedExecution(lateSecondary.decision).executed).toBe(false);
  });

  it('prices each arm from the built body and the documented card, and leaves the fast alias unpriced', () => {
    const primary = readJson('sentinel-primary.json') as { max_completion_tokens: number };
    const secondary = readJson('sentinel-secondary.json') as { max_completion_tokens: number };
    const historical = readJson('historical-critic.json');
    const primaryTokens = estimatePromptTokens(JSON.stringify(primary));
    const secondaryTokens = estimatePromptTokens(JSON.stringify(secondary));
    const historicalTokens = estimatePromptTokens(JSON.stringify(historical));
    const primaryUsd = (primaryTokens * MODEL_CONFIG.primary.pricing.shortContext.input
      + primary.max_completion_tokens * MODEL_CONFIG.primary.pricing.shortContext.output) / 1_000_000;
    const secondaryUsd = (secondaryTokens * MODEL_CONFIG.cascade.secondary.pricing.shortContext.input
      + secondary.max_completion_tokens * MODEL_CONFIG.cascade.secondary.pricing.shortContext.output) / 1_000_000;
    expect(primaryTokens).toBe(4300);
    expect(secondaryTokens).toBe(3569);
    expect(historicalTokens).toBe(454);
    expect(primaryUsd).toBeCloseTo(0.033176, 6);
    expect(secondaryUsd).toBeCloseTo(0.01470125, 8);
    expect(MODEL_CONFIG.primary.model).toBe('grok-4.7');
    expect(MODEL_CONFIG.cascade.secondary.model).toBe('grok-4.3');
    expect(JSON.stringify(MODEL_CONFIG)).not.toContain('grok-4-fast-reasoning');
  });
});
