/** Frozen, bounded native-engine diagnostic. Uses real OpenServ inference only;
 * no Sentinel deployment, live orders, background processes or repair retries.
 * Run with the installed vite-node runner, with SERV credentials in the environment.
 */
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
if (process.env.SERV_BASE_URL !== 'https://inference-api.openserv.ai/v1' || !process.env.SERV_API_KEY?.trim()) throw Error('PROVIDER_CONFIGURATION_MISSING');
if (process.env.SENTINEL_TRADE_CHECKPOINT_MODEL !== 'openserv/gpt-6-sol' || process.env.SENTINEL_TRADE_CHECKPOINT_REASONING_EFFORT !== 'low') throw Error('MODEL_CONFIGURATION_MISMATCH');
const attemptPath = join(directory, 'engine_attempts.jsonl');
if (existsSync(attemptPath)) throw Error('ATTEMPT_ALREADY_STARTED');
if (protocol.calls.length !== 9) throw Error('UNEXPECTED_CALL_COUNT');
for (const call of protocol.calls) {
  if (hash(readFileSync(join(directory, call.request_file))) !== call.request_sha256) throw Error('INPUT_CHANGED');
}
const key = process.env.SERV_API_KEY;
const dump = (name: string, value: unknown) => {
  const text = JSON.stringify(value, null, 2);
  if (text.includes(key)) throw Error('SECRET_IN_OUTPUT');
  writeFileSync(join(directory, name), text + '\n');
};
const originalFetch = globalThis.fetch;
let providerCalls: unknown[] = [];
globalThis.fetch = async (url, options) => {
  if (String(url) !== 'https://inference-api.openserv.ai/v1/chat/completions') throw Error('UNEXPECTED_NETWORK_TARGET');
  if (providerCalls.length) throw Error('UNEXPECTED_RETRY');
  const body = JSON.parse(String(options?.body));
  if (body.model !== 'gpt-6-sol' || body.reasoning_effort !== 'low' || body.max_completion_tokens !== 4096 || 'temperature' in body || 'seed' in body || new Headers(options?.headers).has('x-openserv-disable-braid')) throw Error('WIRE_CONFIGURATION_CHANGED');
  const record: Record<string, unknown> = {request: body, started_at_utc: new Date().toISOString()};
  providerCalls.push(record);
  const started = performance.now();
  try {
    const response = await originalFetch(url, {...options, signal: AbortSignal.timeout(45_000)});
    record.http_status = response.status;
    record.body = await response.clone().json();
    return response;
  } finally {
    record.elapsed_seconds = (performance.now() - started) / 1000;
  }
};
const results: unknown[] = [];
for (const call of protocol.calls) {
  providerCalls = [];
  appendFileSync(attemptPath, JSON.stringify({case: call.case, started_at_utc: new Date().toISOString(), protocol_sha256: hash(protocolBytes)}) + '\n');
  const request: SentinelVerifyRequest = JSON.parse(readFileSync(join(directory, call.request_file), 'utf8'));
  const started = performance.now();
  const record: Record<string, any> = {case: call.case, kind: call.kind, expected_verdict: call.expected_verdict};
  try {
    record.response = await verify(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // Do not persist arbitrary provider/transport exception text.
    record.error = ['OPENSERV_MODEL_MISMATCH', 'OPENSERV_INCOMPLETE_COMPLETION'].includes(message)
      ? message : 'PROVIDER_OR_ENGINE_ERROR';
  }
  record.elapsed_seconds = (performance.now() - started) / 1000;
  record.under_client_deadline_before_network_overhead = record.elapsed_seconds < 8;
  record.provider_calls = providerCalls;
  dump(call.case + '_engine.json', record);
  results.push(record);
  console.log(JSON.stringify({case: call.case, verdict: record.response?.verdict, error: record.error,
    elapsed_seconds: record.elapsed_seconds, provider_calls: providerCalls.length}));
}
dump('engine_results.json', results);
