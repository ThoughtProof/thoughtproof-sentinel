/**
 * Local Redis tests for the mandate replay script.
 * A throwing double is only the fail-closed path. It does not prove atomicity.
 * Atomicity, expiry, and retention run EVAL on redis-server.
 * No model calls, no provider keys, no shared Upstash writes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Redis } from '@upstash/redis';
import { checkWindowThenConsume } from './mandate-proof-window.js';
import { MANDATE_PROOF_SKEW_SECONDS } from './mandate-proof-window.js';
import { isUpstashConfigured } from './upstash-env.js';
import {
  MANDATE_REPLAY_CONSUME_SCRIPT,
  MANDATE_REPLAY_SKEW_SECONDS,
  consumeMandateNonce,
  createMandateReplayClient,
  mandateReplayCommand,
  mandateReplayKey,
  type MandateReplayCommand,
  type MandateReplayConsumeInput,
} from './mandate-replay-store.js';

const REDIS_BIN = '/usr/bin/redis-server';
const hasRedisServer = existsSync(REDIS_BIN);
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

  command(): MandateReplayCommand {
    return {
      eval: (script, keys, args) => this.call(['EVAL', script, String(keys.length), ...keys, ...args]),
      pttl: async (key) => {
        const ttl = await this.call(['PTTL', key]);
        if (typeof ttl !== 'number') throw new Error('pttl was not a number');
        return ttl;
      },
    };
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

describe('mandate replay store without a server', () => {
  it('keeps the skew aligned with the proof window and does not call the pure helper', () => {
    expect(MANDATE_REPLAY_SKEW_SECONDS).toBe(MANDATE_PROOF_SKEW_SECONDS);
    expect(MANDATE_REPLAY_CONSUME_SCRIPT).toContain('redis.call(\'TIME\'');
    expect(MANDATE_REPLAY_CONSUME_SCRIPT).toContain('NX');
    expect(MANDATE_REPLAY_CONSUME_SCRIPT).not.toContain('ARGV[3]');
    const source = readFileSync(new URL('./mandate-replay-store.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('checkWindowThenConsume');
    expect(source).not.toContain('mandate-proof-window');
    expect(source).not.toContain('nowSeconds');
    expect(source).not.toContain('getSharedUpstashRedis');
    expect(source).toContain('retries: 0');
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
    const result = await consumeMandateNonce(
      { accountId: '', nonce: 'nonce-a', iat: NOW, exp: NOW + 60 },
      command,
    );
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'ACCOUNT_UNAVAILABLE' });
    expect(called).toBe(false);
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
});

describe.skipIf(!hasRedisServer)('mandate replay store on local redis-server', () => {
  let port = 0;
  let redisProc: ChildProcess | null = null;

  beforeAll(async () => {
    port = await freePort();
    redisProc = await startRedis(port);
  }, 15_000);

  afterAll(async () => {
    redisProc?.kill('SIGTERM');
    redisProc = null;
  });

  async function open(): Promise<LocalRedis> {
    return LocalRedis.connect(port);
  }

  async function redisNow(redis: LocalRedis): Promise<number> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const clock = await redis.call(['TIME']);
      if (!Array.isArray(clock)) throw new Error('redis TIME failed');
      const seconds = Number(clock[0]);
      const micros = Number(clock[1]);
      if (Number.isFinite(seconds) && micros < 250_000) return seconds;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const clock = await redis.call(['TIME']);
    if (!Array.isArray(clock)) throw new Error('redis TIME failed');
    return Number(clock[0]);
  }

  it('rejects exp == iat inside the script and does not store the nonce', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const nonce = 'nonce-equal-window';
    const result = await consumeMandateNonce(
      { accountId: 'acct-one', nonce, iat: now, exp: now },
      redis.command(),
    );
    expect(result).toEqual({ ok: false, verdict: 'BLOCK', reason: 'non_positive_window' });
    expect(await redis.command().pttl(mandateReplayKey('acct-one', nonce))).toBe(-2);
    redis.close();
  });

  it('rejects the expiry boundary and the seconds on either side', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const exactly = await consumeMandateNonce(
      {
        accountId: 'acct-one',
        nonce: 'nonce-exact',
        iat: now - 120,
        exp: now - MANDATE_REPLAY_SKEW_SECONDS,
      },
      redis.command(),
    );
    const earlier = await consumeMandateNonce(
      {
        accountId: 'acct-one',
        nonce: 'nonce-earlier',
        iat: now - 120,
        exp: now - MANDATE_REPLAY_SKEW_SECONDS - 1,
      },
      redis.command(),
    );
    const fresh = await redisNow(redis);
    const laterExp = fresh - MANDATE_REPLAY_SKEW_SECONDS + 1;
    const later = await consumeMandateNonce(
      {
        accountId: 'acct-one',
        nonce: 'nonce-later',
        iat: fresh - 120,
        exp: laterExp,
      },
      redis.command(),
    );
    expect(exactly).toEqual({ ok: false, verdict: 'BLOCK', reason: 'expired' });
    expect(earlier).toEqual({ ok: false, verdict: 'BLOCK', reason: 'expired' });
    expect(later).toEqual({
      ok: true,
      consumed: true,
      retainUntil: laterExp + MANDATE_REPLAY_SKEW_SECONDS,
    });
    expect(await redis.command().pttl(mandateReplayKey('acct-one', 'nonce-exact'))).toBe(-2);
    expect(await redis.command().pttl(mandateReplayKey('acct-one', 'nonce-earlier'))).toBe(-2);
    const kept = await redis.command().pttl(mandateReplayKey('acct-one', 'nonce-later'));
    expect(kept).toBeGreaterThan(0);
    redis.close();
  });

  it('lets exactly one concurrent consume of the same nonce succeed', async () => {
    const clock = await open();
    const now = await redisNow(clock);
    clock.close();
    const nonce = 'nonce-concurrent';
    const attempts = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const redis = await open();
        try {
          return await consumeMandateNonce(
            {
              accountId: 'acct-one',
              nonce,
              iat: now - 10,
              exp: now + 120,
            },
            redis.command(),
          );
        } finally {
          redis.close();
        }
      }),
    );
    const consumed = attempts.filter((result) => result.ok);
    const replayed = attempts.filter((result) => !result.ok && 'verdict' in result && result.reason === 'replay');
    expect(consumed).toHaveLength(1);
    expect(replayed).toHaveLength(7);
    const outcomes = attempts.map((result) => {
      if (result.ok) return 'consumed';
      if ('verdict' in result) return result.verdict;
      return 'unavailable';
    });
    expect(outcomes).not.toContain('unavailable');
  });

  it('scopes one nonce to each server account id', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const nonce = 'nonce-shared-text';
    const first = await consumeMandateNonce(
      { accountId: 'acct-one', nonce, iat: now - 10, exp: now + 120 },
      redis.command(),
    );
    const second = await consumeMandateNonce(
      { accountId: 'acct-two', nonce, iat: now - 10, exp: now + 120 },
      redis.command(),
    );
    const again = await consumeMandateNonce(
      { accountId: 'acct-one', nonce, iat: now - 10, exp: now + 120 },
      redis.command(),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(again).toEqual({ ok: false, verdict: 'BLOCK', reason: 'replay' });
    redis.close();
  });

  it('keeps a consumed nonce at least until exp + skew', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const nonce = 'nonce-retain';
    const exp = now + 60;
    const result = await consumeMandateNonce(
      { accountId: 'acct-one', nonce, iat: now - 10, exp },
      redis.command(),
    );
    expect(result).toEqual({ ok: true, consumed: true, retainUntil: exp + MANDATE_REPLAY_SKEW_SECONDS });
    const pttl = await redis.command().pttl(mandateReplayKey('acct-one', nonce));
    expect(pttl).toBeGreaterThanOrEqual((exp + MANDATE_REPLAY_SKEW_SECONDS - now - 2) * 1000);
    redis.close();
  });

  it('does not treat checkWindowThenConsume as consumption', async () => {
    const redis = await open();
    const now = await redisNow(redis);
    const nonce = 'nonce-pure-helper';
    const times = { iat: now - 10, exp: now + 120 };
    expect(checkWindowThenConsume(times, now, now)).toEqual({ ok: true });
    expect(await redis.command().pttl(mandateReplayKey('acct-one', nonce))).toBe(-2);
    const stored = await consumeMandateNonce(
      { accountId: 'acct-one', nonce, ...times },
      redis.command(),
    );
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
    const result = await consumeMandateNonce(forged, redis.command());
    expect(result).toEqual({ ok: false, verdict: 'BLOCK', reason: 'expired' });
    expect(await redis.command().pttl(mandateReplayKey('acct-one', nonce))).toBe(-2);
    const again = await consumeMandateNonce(forged, redis.command());
    expect(again).toEqual({ ok: false, verdict: 'BLOCK', reason: 'expired' });
    redis.close();
  });

  it('uses Redis TIME when the caller does not pass a clock', async () => {
    const redis = await open();
    const clock = await redis.call(['TIME']);
    expect(Array.isArray(clock)).toBe(true);
    const now = Number((clock as string[])[0]);
    const result = await consumeMandateNonce(
      { accountId: 'acct-one', nonce: 'nonce-server-clock', iat: now - 10, exp: now + 60 },
      redis.command(),
    );
    expect(result).toEqual({ ok: true, consumed: true, retainUntil: now + 60 + MANDATE_REPLAY_SKEW_SECONDS });
    redis.close();
  });

  it('fails closed when redis answers with an error', async () => {
    const redis = await open();
    const command: MandateReplayCommand = {
      eval: async () => {
        await redis.call(['NO-SUCH-REPLAY-COMMAND']);
        return 'consumed:1';
      },
      pttl: async () => -2,
    };
    const result = await consumeMandateNonce(
      { accountId: 'acct-one', nonce: 'nonce-error', iat: NOW, exp: NOW + 60 },
      command,
    );
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' });
    redis.close();
  });

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

  async function lostResponseServer(redis: LocalRedis): Promise<{ httpPort: number; hits: () => number; close: () => Promise<void> }> {
    let hits = 0;
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        hits += 1;
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        const command = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed[0] : parsed;
        const parts = Array.isArray(command) ? command.map((part) => String(part)) : [];
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
    const client = createMandateReplayClient(`http://127.0.0.1:${gateway.httpPort}`, 'replay-test-token');
    const result = await consumeMandateNonce(
      { accountId: 'acct-one', nonce, iat: now - 10, exp: now + 120 },
      mandateReplayCommand(client),
    );
    expect(gateway.hits()).toBe(1);
    expect(result).toEqual({ ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' });
    const stored = await consumeMandateNonce(
      { accountId: 'acct-one', nonce, iat: now - 10, exp: now + 120 },
      redis.command(),
    );
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
      token: 'replay-test-token',
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
