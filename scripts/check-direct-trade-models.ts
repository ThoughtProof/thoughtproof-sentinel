/** One bounded diagnostic, two direct providers, no deployment or order path. */
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, appendFileSync, existsSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verify} from '../src/engine/index.js';
import type {SentinelVerifyRequest} from '../src/types.js';

const directory = resolve(process.argv[2]);
const protocolBytes = readFileSync(join(directory, 'engine_protocol.json'));
const protocol = JSON.parse(protocolBytes.toString());
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const head = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
if (head !== protocol.server_commit || execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).trim()) throw Error('SOURCE_NOT_FROZEN');
const routes = {
  deepseek: {route: 'deepseek/deepseek-flash', model: 'deepseek-flash', url: 'https://api.deepseek.com/chat/completions', key: process.env.DEEPSEEK_API_KEY},
  xai: {route: 'xai/grok-4.7', model: 'grok-4.7', url: 'https://api.x.ai/v1/chat/completions', key: process.env.XAI_API_KEY},
};
if (Object.values(routes).some(r => !r.key?.trim())) throw Error('PROVIDER_CONFIGURATION_MISSING');
if (protocol.calls.length !== 18 || protocol.max_model_invocations !== 16 || protocol.retries !== 0 || protocol.reasoning_effort !== 'low') throw Error('UNEXPECTED_PROTOCOL');
const attemptPath = join(directory, 'engine_attempts.jsonl');
if (existsSync(attemptPath)) throw Error('ATTEMPT_ALREADY_STARTED');
const ids = new Set();
for (const call of protocol.calls) {
  if (!(call.provider in routes) || ids.has(call.call_id)) throw Error('UNEXPECTED_CALL');
  ids.add(call.call_id);
  if (hash(readFileSync(join(directory, call.request_file))) !== call.request_sha256) throw Error('INPUT_CHANGED');
}
const dump = (name: string, value: unknown) => {
  const text = JSON.stringify(value, null, 2);
  if (Object.values(routes).some(r => text.includes(r.key!))) throw Error('SECRET_IN_OUTPUT');
  writeFileSync(join(directory, name), text + '\n');
};
const originalFetch = globalThis.fetch;
let active: any;
let providerCalls: any[] = [];
const totals = {deepseek: 0, xai: 0};
globalThis.fetch = async (url, options) => {
  const target = routes[active.provider as keyof typeof routes];
  if (String(url) !== target.url) throw Error('UNEXPECTED_NETWORK_TARGET');
  if (providerCalls.length || totals[active.provider as keyof typeof totals] >= 8) throw Error('UNEXPECTED_RETRY');
  const body = JSON.parse(String(options?.body));
  const headers = new Headers(options?.headers);
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['max_tokens', 'messages', 'model', 'reasoning_effort']) || body.model !== target.model || body.reasoning_effort !== 'low' || body.max_tokens !== 4096 || headers.get('Authorization') !== 'Bearer ' + target.key || headers.has('x-openserv-disable-braid')) throw Error('WIRE_CONFIGURATION_CHANGED');
  if (hash(JSON.stringify(body.messages)) !== active.baseline_messages_sha256) throw Error('MESSAGES_CHANGED');
  const record: Record<string, any> = {request: body, started_at_utc: new Date().toISOString()};
  providerCalls.push(record);
  totals[active.provider as keyof typeof totals]++;
  const started = performance.now();
  try {
    const response = await originalFetch(url, {...options, signal: AbortSignal.timeout(45_000)});
    record.http_status = response.status;
    const text = await response.clone().text();
    try { record.body = JSON.parse(text); }
    catch { record.invalid_response_json = true; record.body_sha256 = hash(text); }
    return response;
  } catch {
    record.transport_error = true;
    throw Error('PROVIDER_TRANSPORT_ERROR');
  } finally { record.elapsed_seconds = (performance.now() - started) / 1000; }
};
const results: unknown[] = [];
for (const call of protocol.calls) {
  active = call;
  providerCalls = [];
  process.env.SENTINEL_TRADE_CHECKPOINT_MODEL = routes[call.provider as keyof typeof routes].route;
  process.env.SENTINEL_TRADE_CHECKPOINT_REASONING_EFFORT = 'low';
  appendFileSync(attemptPath, JSON.stringify({call_id: call.call_id, started_at_utc: new Date().toISOString(), protocol_sha256: hash(protocolBytes)}) + '\n');
  const request: SentinelVerifyRequest = JSON.parse(readFileSync(join(directory, call.request_file), 'utf8'));
  const record: Record<string, any> = {call_id: call.call_id, provider: call.provider, case: call.case, kind: call.kind, expected_verdict: call.expected_verdict};
  const started = performance.now();
  try { record.response = await verify(request); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    record.error = ['DIRECT_MODEL_MISMATCH', 'DIRECT_INCOMPLETE_COMPLETION', 'PROVIDER_TRANSPORT_ERROR', 'MESSAGES_CHANGED', 'WIRE_CONFIGURATION_CHANGED', 'UNEXPECTED_RETRY'].includes(message) ? message : 'PROVIDER_OR_ENGINE_ERROR';
  }
  record.elapsed_seconds = (performance.now() - started) / 1000;
  record.under_client_deadline_before_network_overhead = record.elapsed_seconds < 8;
  record.provider_calls = providerCalls;
  dump(call.call_id + '_engine.json', record);
  results.push(record);
  console.log(JSON.stringify({call_id: call.call_id, verdict: record.response?.verdict, error: record.error, elapsed_seconds: record.elapsed_seconds, provider_calls: providerCalls.length}));
}
dump('engine_results.json', results);
