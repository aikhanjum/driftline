import test from 'node:test';
import assert from 'node:assert/strict';
import { runGuardedStream } from '../src/stream-guard.js';

const reading = (input, kind) => ({ kind, confidence: 0.9, requestId: input.requestId, goalVersion: input.goalVersion });

test('a dedicated final verifier sees the complete action only after generation ends', async () => {
  let ended = false;
  let verified = 0;
  const result = await runGuardedStream({
    input: { goal: 'Fix the parser.' },
    minChars: 1,
    pauseAtCheckpoints: true,
    generate: async function* () { yield 'Fix the parser.'; ended = true; },
    score: async (input) => reading(input, 'uncertain'),
    finalScore: async (input) => {
      assert.equal(ended, true);
      assert.equal(input.partialAction, 'Fix the parser.');
      verified += 1;
      return reading(input, 'continue');
    },
  });
  assert.equal(verified, 1);
  assert.equal(result.status, 'completed');
});

test('an approved prefix cannot bypass a rejecting final verifier', async () => {
  const result = await runGuardedStream({
    input: { goal: 'Fix the parser.' },
    minChars: 1,
    pauseAtCheckpoints: true,
    generate: async function* () { yield 'Fix the parser.'; },
    score: async (input) => reading(input, 'continue'),
    finalScore: async (input) => reading(input, 'uncertain'),
  });
  assert.equal(result.status, 'blocked');
});

test('cancellation does not wait for a hung final verifier', async () => {
  const controller = new AbortController();
  const result = await runGuardedStream({
    input: { goal: 'Fix the parser.' },
    signal: controller.signal,
    generate: async function* () { yield 'Fix it.'; },
    score: async (input) => reading(input, 'continue'),
    finalScore: () => {
      controller.abort();
      return new Promise(() => {});
    },
  });
  assert.equal(result.status, 'cancelled');
});
