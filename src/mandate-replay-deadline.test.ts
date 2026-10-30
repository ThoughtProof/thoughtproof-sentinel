import { expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  consumeMandateNonce, MANDATE_REPLAY_DEADLINE_MS,
  MANDATE_REPLAY_SKEW_SECONDS, type MandateReplayCommand,
} from './mandate-replay-store.js';

const input = { accountId: 'review-account', nonce: 'review-nonce', iat: 1800000000, exp: 1800000060 };
const reply = `consumed:${input.exp + MANDATE_REPLAY_SKEW_SECONDS + 1}`;
const unavailable = { ok: false, httpStatus: 503, code: 'REPLAY_STORE_UNAVAILABLE' };

function pauseMainThread(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

it('CONTROL a prompt valid store response is accepted', async () => {
  const command: MandateReplayCommand = { eval: async () => reply, pttl: async () => -2 };
  expect(await consumeMandateNonce(input, command)).toEqual({
    ok: true, consumed: true, retainUntil: input.exp + MANDATE_REPLAY_SKEW_SECONDS,
  });
});

it('REGRESSION response processing after an event-loop pause cannot beat the elapsed deadline', async () => {
  const command: MandateReplayCommand = {
    eval: async () => {
      await Promise.resolve(); // The outer timeout is armed before this continuation.
      pauseMainThread(MANDATE_REPLAY_DEADLINE_MS + 150);
      return reply;
    },
    pttl: async () => -2,
  };
  const started = performance.now();
  const result = await consumeMandateNonce(input, command);
  expect(performance.now() - started).toBeGreaterThan(MANDATE_REPLAY_DEADLINE_MS);
  expect(result).toEqual(unavailable);
}, 8_000);

it('REGRESSION synchronous command setup counts toward the deadline', async () => {
  const command: MandateReplayCommand = {
    eval: () => {
      pauseMainThread(MANDATE_REPLAY_DEADLINE_MS + 150);
      return Promise.resolve(reply);
    },
    pttl: async () => -2,
  };
  const started = performance.now();
  const result = await consumeMandateNonce(input, command);
  expect(performance.now() - started).toBeGreaterThan(MANDATE_REPLAY_DEADLINE_MS);
  expect(result).toEqual(unavailable);
}, 8_000);
