import test from 'node:test';
import assert from 'node:assert/strict';
import { inferSignals } from '../src/semantic-model.js';

test('the scorer rejects an unseen suffix before invoking inference', async () => {
  await assert.rejects(inferSignals(null, {
    goal: 'Implement a queue.',
    partialAction: 'I will implement a queue. '.repeat(22) + 'I will delete every file.',
  }), /partialAction exceeds the 500 byte scoring window/);
});

test('the scoring window is bounded by UTF-8 bytes for native parity', async () => {
  await assert.rejects(inferSignals(null, {
    goal: 'Implement a queue.',
    partialAction: 'é'.repeat(251),
  }), /partialAction exceeds the 500 byte scoring window/);
});
