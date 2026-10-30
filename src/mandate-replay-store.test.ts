/**
 * Local Redis tests for the mandate replay script.
 * A throwing double is only the fail-closed path. It does not prove atomicity.
 * Atomicity, expiry, not-before, and retention run the service's Upstash
 * client (the same Redis SDK the rate limiter uses) against redis-server.
 * The HTTP bridge only forwards that client's commands. It does not decide
 * them. No model calls, no provider keys, no shared Upstash writes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { connect as netConnect, type Socket } from 'node:net';
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { Redis } from '@upstash/redis';
import { checkWindowThenConsume } from './mandate-proof-window.js';
import {
  MANDATE_PROOF_MAX_WINDOW_SECONDS,
  MANDATE_PROOF_SKEW_SECONDS,
} from './mandate-proof-window.js';
import { isUpstashConfigured } from './upstash-env.js';
import {
  MANDATE_REPLAY_CONSUME_SCRIPT,
  MANDATE_REPLAY_DEADLINE_MS,
  MANDATE_REPLAY_MAX_WINDOW_SECONDS,
  MANDATE_REPLAY_SKEW_SECONDS,
  consumeMandateNonce,
  createMandateReplayClient,
  mandateReplayCommand,
  mandateReplayKey,
  type MandateReplayCommand,
  type MandateReplayConsumeInput,
  type MandateReplayConsumeResult,
} from './mandate-replay-store.js';

const REDIS_BIN = ['/usr/bin/redis-server', '/usr/local/bin/redis-server'].find((path) => existsSync(path));
const hasRedisServer = REDIS_BIN !== undefined;
const TOKEN = 'replay-test-token';
const NOW = 1_800_000_000;

function encode(parts: string[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const body = Buffer.from(part);
    chunks.push(Buffer.from(`$${body.length}\r\n`), body, Buffer.from('\r\n'));
  }
  return Buffer.concat(chunks);
}

function parseResp(buf: Buffer, offset: number): { value: unknown; next: number } | null {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const lineEnd = buf.indexOf('\r\n', offset + 1);
  if (lineEnd < 0) return null;
  const head = buf.toString('utf8', offset + 1, lineEnd);
  if (type === '+') return { value: head, next: lineEnd + 2 };
  if (type === '-') return { value: new Error(head), next: lineEnd + 2 };
  if (type === ':') return { value: Number(head), next: lineEnd + 2 };
  if (type === '$') {
    const len = Number(head);
    if (len === -1) return { value: null, next: lineEnd + 2 };
    const start = lineEnd + 2;
    if (buf.length < start + len + 2) return null;
    return { value: buf.toString('utf8', start, start + len), next: start + len + 2 };
  }
  if (type === '*') {
    const count = Number(head);
    if (count === -1) return { value: null, next: lineEnd + 2 };
    const items: unknown[] = [];
    let cursor = lineEnd + 2;
    for (let i = 0; i < count; i += 1) {
      const item = parseResp(buf, cursor);
      if (!item) return null;
      items.push(item.value);
      cursor = item.next;
    }
    return { value: items, next: cursor };
  }
  return { value: new Error('unreadable redis reply'), next: buf.length };
}

class LocalRedis {
  private buf = Buffer.alloc(0);
  private waiters: Array<(value: unknown) => void> = [];

  private constructor(private socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    socket.on('error', (error) => {
      this.fail(error);
    });
  }

  static connect(port: number): Promise<LocalRedis> {
    return new Promise((resolve, reject) => {
      const socket = netConnect({ host: '127.0.0.1', port });
      const onError = (error: Error) => {
        socket.removeListener('connect', onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.removeListener('error', onError);
        resolve(new LocalRedis(socket));
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  call(parts: string[]): Promise<unknown> {
    const promise = new Promise<unknown>((resolve, reject) => {
      this.waiters.push((value) => {
        if (value instanceof Error) reject(value);
        else resolve(value);
      });
    });
    this.socket.write(encode(parts));
    return promise;
  }

  close(): void {
    this.socket.end();
  }

  private drain(): void {
    for (;;) {
      if (this.waiters.length === 0) return;
      const parsed = parseResp(this.buf, 0);
      if (!parsed) return;
      this.buf = this.buf.subarray(parsed.next);
      const waiter = this.waiters.shift();
      waiter?.(parsed.value);
    }
  }

  private fail(error: Error): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(error);
    }
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function startRedis(port: number): Promise<ChildProcess> {
  if (!REDIS_BIN) return Promise.reject(new Error('redis-server is not installed'));
  return new Promise((resolve, reject) => {
    const child = spawn(REDIS_BIN, [
      '--port', String(port),
      '--bind', '127.0.0.1',
      '--protected-mode', 'yes',
      '--save', '',
      '--appendonly', 'no',
      '--daemonize', 'no',
      '--logfile', '',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let started = false;
    const watch = (chunk: Buffer) => {
      if (!started && chunk.toString().includes('Ready to accept connections')) {
        started = true;
        resolve(child);
      }
    };
    child.stdout?.on('data', watch);
    child.stderr?.on('data', watch);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!started) reject(new Error(`redis-server exited ${code ?? 'null'}`));
    });
  });
}

function encodeUpstash(value: unknown): unknown {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64');
  if (typeof value === 'number') return value;
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((item) => encodeUpstash(item));
  return null;
}

function commandsOf(parsed: unknown): unknown[][] {
  if (Array.isArray(parsed) && (parsed.length === 0 || Array.isArray(parsed[0]))) {
    return parsed as unknown[][];
  }
  if (Array.isArray(parsed)) return [parsed];
  throw new Error('unreadable redis command');
}

class ArrivalGate {
  private need = 0;
  private arrived: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  arm(count: number): void {
    this.release();
    this.need = count;
  }

  release(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const waiting = this.arrived.splice(0);
    this.need = 0;
    for (const go of waiting) go();
  }

  async wait(): Promise<void> {
    if (this.need <= 1) return;
    await new Promise<void>((resolve) => {
      this.arrived.push(resolve);
      if (this.arrived.length >= this.need) {
        const ready = this.arrived.splice(0);
        this.need = 0;
        if (this.timer !== undefined) {
          clearTimeout(this.timer);
          this.timer = undefined;
        }
        for (const go of ready) go();
        return;
      }
      if (this.timer === undefined) {
        this.timer = setTimeout(() => this.release(), 4_000);
      }
    });
  }
}

interface ReplayBridge {
  url: string;
  maxInFlight: number;
  requests: number;
  hold(count: number): void;
  reset(): void;
  close(): Promise<void>;
}

function startBridge(redisPort: number): Promise<ReplayBridge> {
  const gate = new ArrivalGate();
  let active = 0;
  let maxInFlight = 0;
  let requests = 0;
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    active += 1;
    requests += 1;
    if (active > maxInFlight) maxInFlight = active;
    const chunks: Buffer[] = [];
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      active -= 1;
    };
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', finish);
    req.on('end', () => {
      void (async () => {
        let redis: LocalRedis | null = null;
        try {
          await gate.wait();
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          const commands = commandsOf(parsed);
          redis = await LocalRedis.connect(redisPort);
          const results: Array<{ result?: unknown; error?: string }> = [];
          for (const command of commands) {
            const parts = command.map((part) => String(part));
            try {
              const value = await redis.call(parts);
              results.push({ result: encodeUpstash(value) });
            } catch (error) {
              results.push({ error: error instanceof Error ? error.message : 'store error' });
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(results));
        } catch (error) {
          if (!res.headersSent) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify([{
              error: error instanceof Error ? error.message : 'store error',
            }]));
          }
        } finally {
          redis?.close();
          finish();
        }
      })();
    });
  });
  server.on('clientError', () => {});
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const bridge: ReplayBridge = {
        url: `http://127.0.0.1:${port}`,
        get maxInFlight() {
          return maxInFlight;
        },
        get requests() {
          return requests;
        },
        hold(count: number) {
          gate.arm(count);
        },
        reset() {
          gate.release();
          maxInFlight = 0;
          requests = 0;
        },
        close: () => new Promise((done) => {
          gate.release();
          server.closeAllConnections();
          server.close(() => done());
        }),
      };
      resolve(bridge);
    });
  });
}

function clientCommand(url: string): MandateReplayCommand {
  return mandateReplayCommand(createMandateReplayClient(url, TOKEN));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mandate replay store without a server', () => {
  it('keeps the time rules inside the script and does not call the pure helper', () => {
    expect(MANDATE_REPLAY_SKEW_SECONDS).toBe(MANDATE_PROOF_SKEW_SECONDS);
    expect(MANDATE_REPLAY_MAX_WINDOW_SECONDS).toBe(MANDATE_PROOF_MAX_WINDOW_SECONDS);
    expect(MANDATE_REPLAY_DEADLINE_MS).toBe(2_000);
    expect(MANDATE_REPLAY_CONSUME_SCRIPT).toContain("redis.call('TIME'");
    expect(MANDATE_REPLAY_CONSUME_SCRIPT).toContain('PXAT');
    expect(MANDATE_REPLAY_CONSUME_SCRIPT).toContain('NX');
    expect(MANDATE_REPLAY_CONSUME_SCRIPT).toContain('iat > now + skew');
    expect(MANDATE_REPLAY_CONSUME_SCRIPT).toContain('exp <= now - skew');
    expect(MANDATE_REPLAY_CONSUME_SCRIPT).toContain('exp - iat > maxWindow');
    expect(MANDATE_REPLAY_CONSUME_SCRIPT).not.toContain('ARGV[3]');
    const source = readFileSync(new URL('./mandate-replay-store.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('checkWindowThenConsume');
    expect(source).not.toContain('checkMandateProofTimes');
    expect(source).not.toContain('mandate-proof-window');
    expect(source).not.toContain('nowSeconds');
    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('getSharedUpstashRedis');
    expect(source).toContain('retries: 0');
    expect(source).toContain('mandate_replay_deadline');
    const verify = readFileSync(new URL('../api/sentinel/verify.ts', import.meta.url), 'utf8');
    expect(verify).not.toContain('mandate-replay-store');
  });

  it('scopes the redis key by account id', () => {
    const one = mandateReplayKey('acct-one', 'nonce-a');
    const again = mandateReplayKey('acct-one', 'nonce-a');
    const other = mandateReplayKey('acct-two', 'nonce-a');
    expect(one).toBe(again);
    expect(one).not.toBe(other);
    expect(one.startsWith('sentinel:mandate-replay:v1:')).toBe(true);
  });

  it('fails closed when the account id is missing and does not call the store', async () => {
    let called = false;
    const command: MandateReplayCommand = {
      eval: async () => {
        called = true;
        return 'consumed:1';
      },
      pttl: async () => 1,
    };
    const missing = await consumeMandateNonce(
      { accountId: '', nonce: 'nonce-a', iat: NOW, exp: NOW + 60 },
      command,
    );
    const blank = await consumeMandateNonce(
      { accountId: ' \n\t ', nonce: 'nonce-a', iat: NOW, exp: NOW + 60 },
      command,
    );
    const blankNonce = await consumeMandateNonce(
      { accountId: 'acct-one', nonce: ' ', iat: NOW, exp: NOW + 60 },
      command,
    );
    expect(missing).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });
    expect(blank).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });
    expect(blankNonce).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });
    expect(called).toBe(false);
  });

  it('rejects a non-integer proof time without asking the store', async () => {
    let called = false;
    const command: MandateReplayCommand = {
      eval: async () => {
        called = true;
        return 'consumed:1';
      },
      pttl: async () => 1,
    };
    const fractional = await consumeMandateNonce(
      { accountId: 'acct-one', nonce: 'nonce-a', iat: NOW, exp: NOW + 0.5 },
      command,
    );
    const negative = await consumeMandateNonce(
      { accountId: 'acct-one', nonce: 'nonce-a', iat: -1, exp: NOW },
      command,
    );
    expect(fractional).toEqual({ ok: false, verdict: 'BLOCK', reason: 'non_positive_window' });
    expect(negative).toEqual({ ok: false, verdict: 'BLOCK', reason: 'non_positive_window' });
    expect(called).toBe(false);
    expect(fractional).not.toHaveProperty('verdict', 'ALLOW');
  });

  it('fails closed when the shared client is absent', async () => {
    if (isUpstashConfigured()) return;
    const result = await consumeMandateNonce({
      accountId: 'acct-one',
      nonce: 'nonce-a',
      iat: NOW,
      exp: NOW + 60,
    });
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' });
  });

  it('fails closed when the command is null', async () => {
    const result = await consumeMandateNonce(
      { accountId: 'acct-one', nonce: 'nonce-a', iat: NOW, exp: NOW + 60 },
      null,
    );
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' });
  });

  it('fails closed when a command errors, which is not an atomicity proof', async () => {
    const command: MandateReplayCommand = {
      eval: async () => {
        throw new Error('store down');
      },
      pttl: async () => {
        throw new Error('store down');
      },
    };
    const result = await consumeMandateNonce(
      { accountId: 'acct-one', nonce: 'nonce-a', iat: NOW, exp: NOW + 60 },
      command,
    );
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' });
    expect(result).not.toHaveProperty('verdict', 'ALLOW');
  });

  it('fails closed on an unexpected store reply', async () => {
    const unexpected: MandateReplayCommand = {
      eval: async () => 'block:allow',
      pttl: async () => 1,
    };
    const numeric: MandateReplayCommand = {
      eval: async () => 1,
      pttl: async () => 1,
    };
    const exp = NOW + 60;
    const mismatched: MandateReplayCommand = {
      eval: async () => 'consumed:1',
      pttl: async () => 1,
    };
    expect(await consumeMandateNonce({ accountId: 'acct-one', nonce: 'n', iat: NOW, exp }, unexpected))
      .toEqual({ ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' });
    expect(await consumeMandateNonce({ accountId: 'acct-one', nonce: 'n', iat: NOW, exp }, numeric))
      .toEqual({ ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' });
    expect(await consumeMandateNonce({ accountId: 'acct-one', nonce: 'n', iat: NOW, exp }, mismatched))
      .toEqual({ ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' });
  });

  it('fails closed when the store answers after the deadline and ignores that late success', async () => {
    const exp = NOW + 60;
    let released = false;
    const command: MandateReplayCommand = {
      eval: () => new Promise((resolve) => {
        setTimeout(() => {
          released = true;
          resolve(`consumed:${exp + MANDATE_REPLAY_SKEW_SECONDS + 1}`);
        }, MANDATE_REPLAY_DEADLINE_MS + 250);
      }),
      pttl: async () => -2,
    };
    const started = Date.now();
    const result = await consumeMandateNonce(
      { accountId: 'acct-one', nonce: 'nonce-deadline', iat: NOW, exp },
      command,
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(MANDATE_REPLAY_DEADLINE_MS + 400);
    expect(released).toBe(false);
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' });
    expect(result).not.toHaveProperty('verdict', 'ALLOW');
    await sleep(400);
    expect(released).toBe(true);
    expect(result.ok).toBe(false);
  }, 8_000);
});

describe.skipIf(!hasRedisServer)('mandate replay store on local redis-server through the Upstash client', () => {
  let port = 0;
  let redisProc: ChildProcess | null = null;
  let bridge: ReplayBridge | null = null;

  beforeAll(async () => {
    port = await freePort();
    redisProc = await startRedis(port);
    bridge = await startBridge(port);
  }, 15_000);

  afterEach(() => {
    bridge?.reset();
  });

  afterAll(async () => {
    await bridge?.close();
    bridge = null;
    redisProc?.kill('SIGTERM');
    redisProc = null;
  });

  function bridgeUrl(): string {
    if (!bridge) throw new Error('replay bridge is not running');
    return bridge.url;
  }

  async function open(): Promise<LocalRedis> {
    return LocalRedis.connect(port);
  }

  async function redisNow(redis: LocalRedis): Promise<number> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const clock = await redis.call(['TIME']);
      if (!Array.isArray(clock)) throw new Error('redis TIME failed');
      const seconds = Number(clock[0]);
      const micros = Number(clock[1]);
      if (Number.isFinite(seconds) && micros < 80_000) return seconds;
      await sleep(20);
    }
    const clock = await redis.call(['TIME']);
    if (!Array.isArray(clock)) throw new Error('redis TIME failed');
    return Number(clock[0]);
  }

  async function consume(input: MandateReplayConsumeInput): Promise<MandateReplayConsumeResult> {
    return consumeMandateNonce(input, clientCommand(bridgeUrl()));
  }

  async function pttl(redis: LocalRedis, accountId: string, nonce: string): Promise<number> {
    const ttl = await redis.call(['PTTL', mandateReplayKey(accountId, nonce)]);
    if (typeof ttl !== 'number') throw new Error('pttl was not a number');
    return ttl;
  }

  it('rejects a zero or reversed window inside the script and does not store the nonce', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const equal = await consume({ accountId: 'acct-one', nonce: 'nonce-equal-window', iat: now, exp: now });
    const reversed = await consume({
      accountId: 'acct-one',
      nonce: 'nonce-reversed-window',
      iat: now,
      exp: now - 1,
    });
    expect(equal).toEqual({ ok: false, verdict: 'BLOCK', reason: 'non_positive_window' });
    expect(reversed).toEqual({ ok: false, verdict: 'BLOCK', reason: 'non_positive_window' });
    expect(await pttl(redis, 'acct-one', 'nonce-equal-window')).toBe(-2);
    expect(await pttl(redis, 'acct-one', 'nonce-reversed-window')).toBe(-2);
    redis.close();
  });

  it('rejects the expiry boundary and the seconds on either side', async () => {
    const redis = await open();
    let landed: {
      exactly: MandateReplayConsumeResult;
      earlier: MandateReplayConsumeResult;
      later: MandateReplayConsumeResult;
      laterExp: number;
      laterNonce: string;
      exactlyNonce: string;
      earlierNonce: string;
    } | null = null;
    for (let attempt = 0; attempt < 6 && !landed; attempt += 1) {
      const now = await redisNow(redis);
      const laterExp = now - MANDATE_REPLAY_SKEW_SECONDS + 1;
      const laterNonce = `nonce-later-${attempt}`;
      const exactlyNonce = `nonce-exact-${attempt}`;
      const earlierNonce = `nonce-earlier-${attempt}`;
      const [later, exactly, earlier] = await Promise.all([
        consume({ accountId: 'acct-one', nonce: laterNonce, iat: now - 120, exp: laterExp }),
        consume({
          accountId: 'acct-one',
          nonce: exactlyNonce,
          iat: now - 120,
          exp: now - MANDATE_REPLAY_SKEW_SECONDS,
        }),
        consume({
          accountId: 'acct-one',
          nonce: earlierNonce,
          iat: now - 120,
          exp: now - MANDATE_REPLAY_SKEW_SECONDS - 1,
        }),
      ]);
      if (!later.ok) continue;
      landed = { exactly, earlier, later, laterExp, laterNonce, exactlyNonce, earlierNonce };
    }
    expect(landed).not.toBeNull();
    if (!landed) return;
    expect(landed.exactly).toEqual({ ok: false, verdict: 'BLOCK', reason: 'expired' });
    expect(landed.earlier).toEqual({ ok: false, verdict: 'BLOCK', reason: 'expired' });
    expect(landed.later).toEqual({
      ok: true,
      consumed: true,
      retainUntil: landed.laterExp + MANDATE_REPLAY_SKEW_SECONDS,
    });
    expect(await pttl(redis, 'acct-one', landed.exactlyNonce)).toBe(-2);
    expect(await pttl(redis, 'acct-one', landed.earlierNonce)).toBe(-2);
    const kept = await pttl(redis, 'acct-one', landed.laterNonce);
    expect(kept).toBeGreaterThan(0);
    redis.close();
  });

  it('rejects not-before on the second before, at, and after the skew', async () => {
    const redis = await open();
    let landed: {
      before: MandateReplayConsumeResult;
      at: MandateReplayConsumeResult;
      after: MandateReplayConsumeResult;
      afterNonce: string;
    } | null = null;
    for (let attempt = 0; attempt < 6 && !landed; attempt += 1) {
      const now = await redisNow(redis);
      const beforeNonce = `nonce-nb-before-${attempt}`;
      const atNonce = `nonce-nb-at-${attempt}`;
      const afterNonce = `nonce-nb-after-${attempt}`;
      const [before, at, after] = await Promise.all([
        consume({
          accountId: 'acct-one',
          nonce: beforeNonce,
          iat: now + MANDATE_REPLAY_SKEW_SECONDS - 1,
          exp: now + MANDATE_REPLAY_SKEW_SECONDS - 1 + 60,
        }),
        consume({
          accountId: 'acct-one',
          nonce: atNonce,
          iat: now + MANDATE_REPLAY_SKEW_SECONDS,
          exp: now + MANDATE_REPLAY_SKEW_SECONDS + 60,
        }),
        consume({
          accountId: 'acct-one',
          nonce: afterNonce,
          iat: now + MANDATE_REPLAY_SKEW_SECONDS + 1,
          exp: now + MANDATE_REPLAY_SKEW_SECONDS + 1 + 60,
        }),
      ]);
      if (!before.ok || !at.ok || after.ok) continue;
      landed = { before, at, after, afterNonce };
    }
    expect(landed).not.toBeNull();
    if (!landed) return;
    expect(landed.before.ok).toBe(true);
    expect(landed.at.ok).toBe(true);
    expect(landed.after).toEqual({ ok: false, verdict: 'BLOCK', reason: 'not_yet_valid' });
    expect(await pttl(redis, 'acct-one', landed.afterNonce)).toBe(-2);
    redis.close();
  });

  it('rejects a window longer than five minutes and does not store it', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const accepted = await consume({
      accountId: 'acct-one',
      nonce: 'nonce-window-300',
      iat: now,
      exp: now + MANDATE_REPLAY_MAX_WINDOW_SECONDS,
    });
    const rejected = await consume({
      accountId: 'acct-one',
      nonce: 'nonce-window-301',
      iat: now,
      exp: now + MANDATE_REPLAY_MAX_WINDOW_SECONDS + 1,
    });
    expect(accepted).toEqual({
      ok: true,
      consumed: true,
      retainUntil: now + MANDATE_REPLAY_MAX_WINDOW_SECONDS + MANDATE_REPLAY_SKEW_SECONDS,
    });
    expect(rejected).toEqual({ ok: false, verdict: 'BLOCK', reason: 'window_too_long' });
    expect(await pttl(redis, 'acct-one', 'nonce-window-301')).toBe(-2);
    redis.close();
  });

  it('lets exactly one of eight overlapping client requests consume the same nonce', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const nonce = 'nonce-concurrent';
    bridge?.reset();
    bridge?.hold(8);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => consume({
        accountId: 'acct-one',
        nonce,
        iat: now - 10,
        exp: now + 120,
      })),
    );
    const consumed = attempts.filter((result) => result.ok);
    const replayed = attempts.filter((result) => !result.ok && 'reason' in result && result.reason === 'replay');
    expect(bridge?.maxInFlight).toBe(8);
    expect(consumed).toHaveLength(1);
    expect(replayed).toHaveLength(7);
    expect(JSON.stringify(attempts)).not.toContain('ALLOW');
    expect(await pttl(redis, 'acct-one', nonce)).toBeGreaterThan(0);
    const again = await consume({ accountId: 'acct-one', nonce, iat: now - 10, exp: now + 120 });
    expect(again).toEqual({ ok: false, verdict: 'BLOCK', reason: 'replay' });
    redis.close();
  });

  it('accepts eight overlapping consumes when each nonce is distinct', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    bridge?.reset();
    bridge?.hold(8);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, index) => consume({
        accountId: 'acct-one',
        nonce: `nonce-distinct-${index}`,
        iat: now - 10,
        exp: now + 120,
      })),
    );
    expect(bridge?.maxInFlight).toBe(8);
    expect(attempts.filter((result) => result.ok)).toHaveLength(8);
    expect(JSON.stringify(attempts)).not.toContain('ALLOW');
    redis.close();
  });

  it('lets one shared client accept only one of eight parallel consumes', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const nonce = 'nonce-shared-client';
    const shared = clientCommand(bridgeUrl());
    bridge?.reset();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => consumeMandateNonce(
        { accountId: 'acct-one', nonce, iat: now - 10, exp: now + 120 },
        shared,
      )),
    );
    const consumed = attempts.filter((result) => result.ok);
    const replayed = attempts.filter((result) => !result.ok && 'reason' in result && result.reason === 'replay');
    expect(consumed).toHaveLength(1);
    expect(replayed).toHaveLength(7);
    expect(bridge?.requests).toBeGreaterThan(0);
    expect(await pttl(redis, 'acct-one', nonce)).toBeGreaterThan(0);
    redis.close();
  });

  it('scopes one nonce to each server account id', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const nonce = 'nonce-shared-text';
    const first = await consume({ accountId: 'acct-one', nonce, iat: now - 10, exp: now + 120 });
    const second = await consume({ accountId: 'acct-two', nonce, iat: now - 10, exp: now + 120 });
    const again = await consume({ accountId: 'acct-one', nonce, iat: now - 10, exp: now + 120 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(again).toEqual({ ok: false, verdict: 'BLOCK', reason: 'replay' });
    redis.close();
  });

  it('keeps a consumed nonce through exp + skew and rejects it after the TTL', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const exp = now + 60;
    const nonce = 'nonce-retain';
    const result = await consume({ accountId: 'acct-one', nonce, iat: now - 10, exp });
    expect(result).toEqual({
      ok: true,
      consumed: true,
      retainUntil: exp + MANDATE_REPLAY_SKEW_SECONDS,
    });
    const key = mandateReplayKey('acct-one', nonce);
    const expireTime = await redis.call(['EXPIRETIME', key]);
    expect(expireTime).toBe(exp + MANDATE_REPLAY_SKEW_SECONDS + 1);
    expect(await pttl(redis, 'acct-one', nonce)).toBeGreaterThan(
      (exp + MANDATE_REPLAY_SKEW_SECONDS - now) * 1000,
    );

    const shortNonce = 'nonce-short-ttl';
    let shortExp = 0;
    let stored = false;
    for (let attempt = 0; attempt < 6 && !stored; attempt += 1) {
      const fresh = await redisNow(redis);
      shortExp = fresh - MANDATE_REPLAY_SKEW_SECONDS + 1;
      const short = await consume({
        accountId: 'acct-one',
        nonce: shortNonce,
        iat: fresh - 120,
        exp: shortExp,
      });
      stored = short.ok === true;
    }
    expect(stored).toBe(true);
    const shortKey = mandateReplayKey('acct-one', shortNonce);
    expect(await redis.call(['EXPIRETIME', shortKey])).toBe(shortExp + MANDATE_REPLAY_SKEW_SECONDS + 1);
    expect(await pttl(redis, 'acct-one', shortNonce)).toBeGreaterThan(0);
    const deadline = Date.now() + 8_000;
    let gone = false;
    while (Date.now() < deadline) {
      if (await pttl(redis, 'acct-one', shortNonce) === -2) {
        gone = true;
        break;
      }
      await sleep(40);
    }
    expect(gone).toBe(true);
    const again = await consume({
      accountId: 'acct-one',
      nonce: shortNonce,
      iat: shortExp - 60,
      exp: shortExp,
    });
    expect(again).toEqual({ ok: false, verdict: 'BLOCK', reason: 'expired' });
    expect(await pttl(redis, 'acct-one', shortNonce)).toBe(-2);
    redis.close();
  }, 15_000);

  it('does not treat checkWindowThenConsume as consumption', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const nonce = 'nonce-pure-helper';
    const times = { iat: now - 10, exp: now + 120 };
    expect(checkWindowThenConsume(times, now, now)).toEqual({ ok: true });
    expect(await pttl(redis, 'acct-one', nonce)).toBe(-2);
    const stored = await consume({ accountId: 'acct-one', nonce, ...times });
    expect(stored.ok).toBe(true);
    redis.close();
  });

  it('rejects an expired proof even when a stale caller clock is attached', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const stale = now - 10_000;
    const nonce = 'nonce-stale-clock';
    const forged = {
      accountId: 'acct-one',
      nonce,
      iat: stale,
      exp: stale + 60,
      nowSeconds: stale,
    } as MandateReplayConsumeInput;
    const result = await consume(forged);
    expect(result).toEqual({ ok: false, verdict: 'BLOCK', reason: 'expired' });
    expect(await pttl(redis, 'acct-one', nonce)).toBe(-2);
    const again = await consume(forged);
    expect(again).toEqual({ ok: false, verdict: 'BLOCK', reason: 'expired' });
    redis.close();
  });

  it('fails closed when the real client receives a store error', async () => {
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ error: 'LOADING Redis is loading the dataset in memory' }]));
      });
    });
    const httpPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const result = await consumeMandateNonce(
      { accountId: 'acct-one', nonce: 'nonce-loading', iat: NOW, exp: NOW + 60 },
      clientCommand(`http://127.0.0.1:${httpPort}`),
    );
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' });
    expect(result).not.toHaveProperty('verdict', 'ALLOW');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fails closed when the real client gets no response before the deadline', async () => {
    const sockets = new Set<IncomingMessage['socket']>();
    const server = createHttpServer((req) => {
      sockets.add(req.socket);
      req.on('data', () => {});
    });
    const httpPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const started = Date.now();
    const result = await consumeMandateNonce(
      { accountId: 'acct-one', nonce: 'nonce-hang', iat: NOW, exp: NOW + 60 },
      clientCommand(`http://127.0.0.1:${httpPort}`),
    );
    expect(Date.now() - started).toBeLessThan(MANDATE_REPLAY_DEADLINE_MS + 1_000);
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' });
    expect(result).not.toHaveProperty('verdict', 'ALLOW');
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 8_000);

  it('fails closed when the store port is closed', async () => {
    const closed = netConnect({ host: '127.0.0.1', port: 1 });
    const failed = new Promise<never>((_resolve, reject) => {
      closed.once('error', reject);
    });
    const command: MandateReplayCommand = {
      eval: async () => {
        await failed;
        return 'consumed:1';
      },
      pttl: async () => -2,
    };
    const result = await consumeMandateNonce(
      { accountId: 'acct-one', nonce: 'nonce-closed', iat: NOW, exp: NOW + 60 },
      command,
    );
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' });
    closed.destroy();
  });

  async function lostResponseServer(redis: LocalRedis): Promise<{
    httpPort: number;
    hits: () => number;
    close: () => Promise<void>;
  }> {
    let hits = 0;
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        hits += 1;
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        const commands = commandsOf(parsed);
        const parts = commands[0]?.map((part) => String(part)) ?? [];
        if (hits === 1) {
          void redis.call(parts).then(() => {
            req.socket.destroy();
          }).catch(() => {
            req.socket.destroy();
          });
          return;
        }
        const encoded = Buffer.from('block:replay', 'utf8').toString('base64');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ result: encoded }]));
      });
    });
    server.on('clientError', () => {});
    const httpPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    return {
      httpPort,
      hits: () => hits,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }

  it('returns 503 when the success response is lost and does not retry into a replay', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const nonce = 'nonce-lost-response';
    const gateway = await lostResponseServer(redis);
    const client = createMandateReplayClient(`http://127.0.0.1:${gateway.httpPort}`, TOKEN);
    const result = await consumeMandateNonce(
      { accountId: 'acct-one', nonce, iat: now - 10, exp: now + 120 },
      mandateReplayCommand(client),
    );
    expect(gateway.hits()).toBe(1);
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' });
    const stored = await consume({ accountId: 'acct-one', nonce, iat: now - 10, exp: now + 120 });
    expect(stored).toEqual({ ok: false, verdict: 'BLOCK', reason: 'replay' });
    await gateway.close();
    redis.close();
  });

  it('shows the SDK default retry can turn that lost success into replay', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const nonce = 'nonce-retry-control';
    const gateway = await lostResponseServer(redis);
    const client = new Redis({
      url: `http://127.0.0.1:${gateway.httpPort}`,
      token: TOKEN,
      retry: { retries: 1 },
    });
    const result = await consumeMandateNonce(
      { accountId: 'acct-one', nonce, iat: now - 10, exp: now + 120 },
      mandateReplayCommand(client),
    );
    expect(gateway.hits()).toBe(2);
    expect(result).toEqual({ ok: false, verdict: 'BLOCK', reason: 'replay' });
    await gateway.close();
    redis.close();
  });
});
