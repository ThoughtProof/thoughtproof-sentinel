/**
 * Offline: the rendered trade_execution provider request for every frozen
 * justified order. Fetch is stubbed. No provider call.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectMandateVerbatimQuote } from 'pot-cli/plv';
import { verify } from './index.js';
import { tradeExecutionTrace } from './modes/trade_execution.js';
import { resetTradeExecutionQualityForTests } from './trade-execution-quality.js';

const LABELS_SHA = '80c57f52c308968c393c1883c9c69f8355ff1971f58a24d8ef86825561078d16';
const CASES_SHA = '7d9d88722722ca89d9c10fef275f082217fc751b024c67ee3aa43c5d3c3bc9bb';

interface FrozenCase {
  id: string;
  group: string;
  claim: string;
  evidence: string;
}

function section(prompt: string, name: string, until: string): string {
  const start = prompt.indexOf(`${name}:\n`);
  if (start < 0) return '';
  const from = start + name.length + 2;
  const end = prompt.indexOf(until, from);
  return end < 0 ? prompt.slice(from) : prompt.slice(from, end);
}

function passingSteps(quote: string): string {
  return JSON.stringify([0, 1, 2].map((i) => ({
    step_id: `step_${i}`,
    score: 1,
    reasoning: `stub step ${i}`,
    quote,
  })));
}

describe('rendered trade_execution prompts for frozen justified orders', () => {
  const cases = (JSON.parse(readFileSync(
    join(process.cwd(), 'test/fixtures/fix3-allow-audit/cases.json'),
    'utf8',
  )) as { cases: FrozenCase[] }).cases.filter((item) => item.group === 'justified_plain');

  beforeEach(() => {
    resetTradeExecutionQualityForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('SERV_API_KEY', 'offline-test-not-a-secret');
    vi.stubEnv('CONFIRM_BLOCKS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTradeExecutionQualityForTests();
  });

  it('keeps the frozen hashes', () => {
    const root = process.cwd();
    expect(createHash('sha256').update(readFileSync(join(root, 'test/fixtures/fix3-allow-audit/labels.json'))).digest('hex')).toBe(LABELS_SHA);
    expect(createHash('sha256').update(readFileSync(join(root, 'test/fixtures/fix3-allow-audit/cases.json'))).digest('hex')).toBe(CASES_SHA);
    expect(cases).toHaveLength(10);
  });

  it('puts the full order inside TRACE EXCERPT for nano and swift, BUY and SELL', async () => {
    const captured: Array<{ id: string; model: string; user: string; system: string }> = [];
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string;
        messages?: Array<{ role?: string; content?: string }>;
      };
      const user = body.messages?.find((message) => message.role === 'user')?.content ?? '';
      const system = body.messages?.find((message) => message.role === 'system')?.content ?? '';
      captured.push({ id: '', model: body.model ?? '', user, system });
      const quote = user.includes('uptrend')
        ? 'shows an uptrend and support holds near the shelf.'
        : 'shows a downtrend and a breakdown under the shelf.';
      return new Response(JSON.stringify({
        model: body.model,
        choices: [{ message: { content: passingSteps(quote) }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    for (const item of cases) {
      const before = captured.length;
      await verify({
        claim: item.claim,
        evidence: item.evidence,
        mode: 'trade_execution',
        tier: 'standard',
        id: item.id,
      });
      for (const row of captured.slice(before)) row.id = item.id;
    }

    expect(captured.filter((row) => row.model === 'serv-nano')).toHaveLength(10);
    expect(captured.filter((row) => row.model === 'serv-swift')).toHaveLength(10);

    for (const item of cases) {
      const side = item.claim.startsWith('SELL') ? 'SELL' : 'BUY';
      const size = item.claim.match(/\d+(?:\.\d+)?/)?.[0] ?? '';
      for (const model of ['serv-nano', 'serv-swift']) {
        const rows = captured.filter((row) => row.id === item.id && row.model === model);
        expect(rows.length).toBeGreaterThan(0);
        const prompt = rows[0]!.user;
        const trace = section(prompt, 'TRACE EXCERPT', '\n---');
        const answer = section(prompt, 'AGENT ANSWER', '\nTRACE EXCERPT:');
        expect(trace).toContain(item.claim);
        expect(trace).toContain(side);
        expect(trace).toContain(size);
        expect(trace).toContain('Coinbase');
        expect(trace).toContain(item.evidence);
        expect(trace).toBe(`ORDER:\n${item.claim}\n\nEVIDENCE:\n${item.evidence}\n`);
        expect(answer.trim()).toBe(item.claim);
        expect(answer.startsWith(item.claim)).toBe(true);
        expect(prompt.length).toBeGreaterThan(item.claim.length + item.evidence.length);
        const gold = prompt.split('GOLD STEPS TO EVALUATE:')[1] ?? '';
        expect(gold.match(/EVIDENCE_SOURCE: trace/g)).toHaveLength(3);
        expect(gold).not.toContain('EVIDENCE_SOURCE: answer');
        if (model === 'serv-nano') {
          expect(rows[0]!.system).toContain('STRICT OUTPUT CONTRACT');
        } else {
          expect(rows[0]!.system).not.toContain('STRICT OUTPUT CONTRACT');
        }
      }
      const nano = captured.find((row) => row.id === item.id && row.model === 'serv-nano')!;
      const swift = captured.find((row) => row.id === item.id && row.model === 'serv-swift')!;
      expect(section(nano.user, 'TRACE EXCERPT', '\n---')).toBe(section(swift.user, 'TRACE EXCERPT', '\n---'));
    }
  });

  it('still sees a mandate conflict after the order is placed in the trace', () => {
    const claim = 'BUY market order: 75 USDC of XRP-USDC on Coinbase';
    const evidence = 'Mandate:\nAllow a starter buy of the named product\nPrincipal instruction:\nDo not trade this product at all\nThesis: XRP shows an uptrend and support holds near the shelf.';
    expect(inspectMandateVerbatimQuote(tradeExecutionTrace(claim, evidence)).status).toBe('conflict');
    expect(inspectMandateVerbatimQuote(evidence).status).toBe('conflict');
  });
});
