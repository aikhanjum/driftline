import test from 'node:test';
import assert from 'node:assert/strict';
import { runComparison } from '../server/live-agent.js';
import { runGuardedStream } from '../src/stream-guard.js';
import { inferSignals } from '../src/semantic-model.js';
import { makeDecision } from '../src/scorer-core.js';

function reading(input, kind = 'continue') {
  return { kind, confidence: 0.9, requestId: input.requestId, goalVersion: input.goalVersion };
}

test('comparison opts into requirement verification only for complete generated actions', async () => {
  const first = 'I will implement the benchmark in C++20. ';
  const second = 'I will report p50, p95, p99 and throughput.';
  const requests = [];
  const result = await runComparison({
    input: {
      goal: 'Implement a queue benchmark.',
      constraints: 'Use C++20. Report latency and throughput.',
      disturbance: 'Write a song.',
    },
    signal: new AbortController().signal,
    onEvent() {},
    generatorFactory: () => async function* () { yield first; yield second; },
    score: async (input) => {
      requests.push(input);
      return reading(input, input.verifyRequirements ? 'continue' : 'uncertain');
    },
  });
  assert.equal(result.guarded.status, 'completed');
  const verified = requests.filter((input) => input.verifyRequirements === true);
  assert.equal(verified.length, 2);
  assert.equal(verified[0].requestId, 'unguarded-final');
  for (const input of verified) assert.equal(input.partialAction, first + second);
  const provisional = requests.filter((input) => input.verifyRequirements !== true);
  assert.ok(provisional.length >= 1);
  assert.ok(provisional.some((input) => input.partialAction === first));
  assert.equal(new Set(requests.map((input) => input.requestId)).size, requests.length);
});

test('a delayed approved prefix cannot replace a final decision with the wrong identity', async () => {
  let requested;
  let release;
  const requestStarted = new Promise((resolve) => { requested = resolve; });
  const scoreRelease = new Promise((resolve) => { release = resolve; });
  const full = 'I will prepare the report. I will preserve the original data.';
  let finalRequest;
  const result = await runGuardedStream({
    input: { goal: 'Prepare a report.', goalVersion: 7 },
    minChars: 1,
    generate: async function* () {
      yield 'I will prepare the report.';
      await requestStarted;
      yield ' I will preserve the original data.';
    },
    score: async (input) => {
      requested();
      await scoreRelease;
      return reading(input);
    },
    finalScore: async (input) => {
      finalRequest = input;
      return { ...reading(input), requestId: 'a-different-request' };
    },
    onEvent: (event) => {
      if (event.type === 'delta' && event.text === full) release();
    },
  });
  assert.equal(finalRequest.partialAction, full);
  assert.equal(finalRequest.goalVersion, 7);
  assert.equal(result.status, 'blocked');
  assert.equal(result.decision, null);
});

function classifierFixture({ unsupported, finalTokenCount = 5 } = {}) {
  const finalPairs = [];
  let finalModelCalls = 0;
  const classifier = async (_text, labels) => ({
    labels,
    scores: labels.map((label) => label.startsWith('continue') ? 0.99
      : label.startsWith('leave') ? 0.64 : label.startsWith('commit') ? 0.8 : 0.01),
  });
  classifier.tokenizer = (premise, options) => {
    const final = typeof premise === 'string';
    if (final) finalPairs.push({ premise, hypothesis: options.text_pair, truncation: options.truncation });
    return {
      final,
      hypothesis: options.text_pair,
      batch: Array.isArray(premise) ? premise.length : 1,
      input_ids: { data: new BigInt64Array(final ? finalTokenCount : 5) },
    };
  };
  classifier.model = async (tokens) => {
    if (tokens.final) finalModelCalls += 1;
    const logits = tokens.final
      ? tokens.hypothesis === unsupported ? [6, -6, 0] : [-6, 6, 0]
      : [-6, 0, 6];
    return { logits: { data: Float32Array.from(Array.from({ length: tokens.batch }, () => logits).flat()) } };
  };
  classifier.model.config = { label2id: { contradiction: 0, entailment: 1, neutral: 2 } };
  return { classifier, finalPairs, finalModelCalls: () => finalModelCalls };
}

test('final inference checks the seventh requirement and retains the entire proposed action', async () => {
  const lastRequirement = 'Do not publish the files.';
  const goalSentences = [
    'Inspect the directory.', 'List the files.', 'Count the files.',
    'Measure their sizes.', 'Group their extensions.', 'Write a summary.',
  ];
  const input = {
    goal: goalSentences.join(' '),
    constraints: lastRequirement,
    partialAction: 'I will inspect and summarize the files. I will publish the files afterward.',
    verifyRequirements: true,
  };
  const fixture = classifierFixture({ unsupported: lastRequirement });
  const signals = await inferSignals(fixture.classifier, input);
  assert.deepEqual(fixture.finalPairs.map((pair) => pair.hypothesis), [...goalSentences, lastRequirement]);
  assert.ok(fixture.finalPairs.every((pair) => pair.premise === input.partialAction && pair.truncation === false));
  const result = makeDecision(input, signals, 1);
  assert.equal(result.kind, 'uncertain');
  assert.equal(result.requirementVerification.supported, false);
  assert.equal(result.requirementVerification.applied, false);
});

test('final inference rejects token overflow before passing a truncated pair to the model', async () => {
  const fixture = classifierFixture({ finalTokenCount: 513 });
  await assert.rejects(inferSignals(fixture.classifier, {
    goal: 'Preserve the files.',
    constraints: '',
    partialAction: 'I will preserve every file.',
    verifyRequirements: true,
  }), /complete 512 token window/);
  assert.equal(fixture.finalModelCalls(), 0);
});
