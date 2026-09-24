import test from 'node:test';
import assert from 'node:assert/strict';
import { runComparison } from '../server/live-agent.js';

test('a comparison aborts even if the baseline scorer never settles', async () => {
  const controller = new AbortController();
  const result = runComparison({
    input: { goal: 'Sort the numbers.', constraints: '', disturbance: 'Write a story.' },
    signal: controller.signal,
    onEvent() {},
    generatorFactory: () => async function* () { yield 'I will write a story.'; },
    score: () => {
      controller.abort(new Error('Deadline reached.'));
      return new Promise(() => {});
    },
  });
  await assert.rejects(result, /Deadline reached/);
});

test('an invalid comparison brief never invokes a model', async () => {
  let invoked = false;
  await assert.rejects(runComparison({
    input: { goal: '', constraints: '', disturbance: 'Write a story.' },
    signal: new AbortController().signal,
    onEvent() {},
    score: () => {},
    generatorFactory: () => { invoked = true; },
  }), /Provide goal/);
  assert.equal(invoked, false);
});
