import test from 'node:test';
import assert from 'node:assert/strict';
import { runGuardedStream } from '../src/stream-guard.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function reading(input, kind = 'continue', adjustment = null) {
  return {
    kind,
    confidence: 0.9,
    adjustment,
    goalVersion: input.goalVersion,
    requestId: input.requestId,
  };
}

const input = { goal: 'Repair the parser.', constraints: 'Keep the tests.', goalVersion: 2 };

test('a current pivot aborts the provider before completion and forwards the exact correction', async () => {
  const order = [];
  const adjustment = 'Preserve the tests and fix the parser implementation.';
  const result = await runGuardedStream({
    input,
    minChars: 1,
    generate: async function* ({ signal, adjustment: received, attempt }) {
      if (attempt === 0) {
        const stopped = new Promise((resolve) => signal.addEventListener('abort', () => {
          order.push('provider aborted');
          resolve();
        }, { once: true }));
        yield 'Delete the tests.';
        await stopped;
        assert.equal(signal.aborted, true);
        return;
      }
      assert.equal(received, adjustment);
      assert.deepEqual(order, ['provider aborted', 'interrupted', 'resumed']);
      yield 'Fix the parser and retain the tests.';
    },
    score: async (request) => request.partialAction.startsWith('Delete')
      ? reading(request, 'pivot', adjustment) : reading(request),
    onEvent: (event) => {
      if (['interrupted', 'resumed', 'complete'].includes(event.type)) order.push(event.type);
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.corrections, 1);
  assert.equal(result.text, 'Fix the parser and retain the tests.');
  assert.deepEqual(order, ['provider aborted', 'interrupted', 'resumed', 'complete']);
});

test('scoring is serial and a stale pivot cannot discard the latest queued prefix', async () => {
  const firstRequested = deferred();
  const latestDelivered = deferred();
  const releaseFirst = deferred();
  const requests = [];
  const events = [];
  let active = 0;
  let maxActive = 0;
  const guard = runGuardedStream({
    input,
    minChars: 1,
    sampleEveryChars: 100,
    generate: async function* () {
      yield 'Delete';
      await firstRequested.promise;
      yield ' nothing.';
      yield ' Fix the parser.';
    },
    score: async (request) => {
      requests.push(request.partialAction);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (requests.length === 1) {
        firstRequested.resolve();
        await releaseFirst.promise;
        active -= 1;
        return reading(request, 'pivot', 'Do not delete anything.');
      }
      active -= 1;
      return reading(request);
    },
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'delta' && event.text === 'Delete nothing. Fix the parser.') latestDelivered.resolve();
    },
  });
  await latestDelivered.promise;
  releaseFirst.resolve();
  const result = await guard;
  assert.equal(result.status, 'completed');
  assert.equal(result.corrections, 0);
  assert.equal(maxActive, 1);
  assert.deepEqual(requests, ['Delete', 'Delete nothing. Fix the parser.']);
  assert.equal(events.filter((event) => event.type === 'interrupted').length, 0);
  assert.equal(events.find((event) => event.type === 'reading').stale, true);
});

test('completion waits for the final full text even below the sampling threshold', async () => {
  const scored = deferred();
  const release = deferred();
  const events = [];
  const guard = runGuardedStream({
    input,
    generate: async function* () { yield 'Fix it.'; },
    score: async (request) => {
      assert.equal(request.partialAction, 'Fix it.');
      scored.resolve();
      await release.promise;
      return reading(request);
    },
    onEvent: (event) => events.push(event.type),
  });
  await scored.promise;
  assert.equal(events.includes('complete'), false);
  release.resolve();
  assert.equal((await guard).status, 'completed');
  assert.equal(events.at(-1), 'complete');
});

test('uncertainty blocks completed output', async () => {
  const events = [];
  const result = await runGuardedStream({
    input,
    generate: async function* () { yield 'Maybe make a different change.'; },
    score: async (request) => reading(request, 'uncertain'),
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, 'blocked');
  assert.equal(events.at(-1).reason, 'uncertain');
  assert.equal(events.some((event) => event.type === 'complete'), false);
});

test('parent abort stops a provider with a pending read and ignores late scoring', async () => {
  const parent = new AbortController();
  const started = deferred();
  const scoreStarted = deferred();
  const scoreRelease = deferred();
  let providerAborted = false;
  const events = [];
  const guard = runGuardedStream({
    input,
    minChars: 1,
    signal: parent.signal,
    generate: async function* ({ signal }) {
      const stopped = new Promise((resolve) => signal.addEventListener('abort', () => {
        providerAborted = true;
        resolve();
      }, { once: true }));
      yield 'Fix the parser.';
      started.resolve();
      await stopped;
    },
    score: async (request) => {
      scoreStarted.resolve();
      await scoreRelease.promise;
      return reading(request);
    },
    onEvent: (event) => events.push(event.type),
  });
  await Promise.all([started.promise, scoreStarted.promise]);
  parent.abort();
  const result = await guard;
  assert.equal(result.status, 'cancelled');
  assert.equal(providerAborted, true);
  scoreRelease.resolve();
  await Promise.resolve();
  assert.equal(events.includes('complete'), false);
});

test('an approved prefix cannot authorize an unscored final suffix', async () => {
  const prefixApproved = deferred();
  const requests = [];
  const result = await runGuardedStream({
    input,
    minChars: 1,
    sampleEveryChars: 100,
    generate: async function* () {
      yield 'Fix the parser.';
      await prefixApproved.promise;
      yield ' Or not.';
    },
    score: async (request) => {
      requests.push(request.partialAction);
      return reading(request, requests.length === 1 ? 'continue' : 'uncertain');
    },
    onEvent: (event) => {
      if (event.type === 'reading') prefixApproved.resolve();
    },
  });
  assert.deepEqual(requests, ['Fix the parser.', 'Fix the parser. Or not.']);
  assert.equal(result.status, 'blocked');
  assert.equal(result.decision.kind, 'uncertain');
});

test('scorer and provider failures block output and abort the source', async (t) => {
  for (const failure of ['scorer', 'provider']) {
    await t.test(failure, async () => {
      let sourceSignal;
      const events = [];
      const result = await runGuardedStream({
        input,
        generate: async function* ({ signal }) {
          sourceSignal = signal;
          yield 'Fix the parser.';
          if (failure === 'provider') throw new Error('Provider disconnected.');
        },
        score: async (request) => {
          if (failure === 'scorer') throw new Error('Scorer unavailable.');
          return reading(request);
        },
        onEvent: (event) => events.push(event),
      });
      assert.equal(result.status, 'blocked');
      assert.equal(sourceSignal.aborted, true);
      assert.equal(events.at(-1).reason, `${failure}_error`);
    });
  }
});

test('exhausting the correction budget blocks a second pivot', async () => {
  const adjustments = [];
  const result = await runGuardedStream({
    input,
    generate: async function* ({ adjustment }) {
      adjustments.push(adjustment);
      yield 'Delete the tests.';
    },
    score: async (request) => reading(request, 'pivot', 'Keep the tests.'),
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.corrections, 1);
  assert.deepEqual(adjustments, [null, 'Keep the tests.']);
});

test('a result with the wrong request identity cannot authorize final output', async () => {
  const result = await runGuardedStream({
    input,
    generate: async function* () { yield 'Fix the parser.'; },
    score: async (request) => ({ ...reading(request), requestId: 'old-request' }),
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.decision, null);
});

test('checkpoint backpressure lets a pivot abort a fast provider before natural completion', async () => {
  const scoring = deferred();
  const releaseScore = deferred();
  let consumed = 0;
  let naturallyCompleted = false;
  let providerAborted = false;
  const guard = runGuardedStream({
    input,
    minChars: 1,
    sampleEveryChars: 1,
    maxCorrections: 0,
    pauseAtCheckpoints: true,
    generate: async function* ({ signal }) {
      signal.addEventListener('abort', () => { providerAborted = true; }, { once: true });
      for (const delta of ['Delete the tests.', ' Then rewrite everything.', ' Then deploy.']) {
        consumed += 1;
        yield delta;
      }
      naturallyCompleted = true;
    },
    score: async (request) => {
      scoring.resolve();
      await releaseScore.promise;
      return reading(request, 'pivot', 'Keep the tests and fix the parser.');
    },
  });
  await scoring.promise;
  assert.equal(consumed, 1);
  assert.equal(naturallyCompleted, false);
  releaseScore.resolve();
  const result = await guard;
  assert.equal(result.status, 'blocked');
  assert.equal(providerAborted, true);
  assert.equal(consumed, 1);
  assert.equal(naturallyCompleted, false);
});

test('parent abort stops a stream paused at a scoring checkpoint', async () => {
  const parent = new AbortController();
  const scoring = deferred();
  const releaseScore = deferred();
  let providerSignal;
  let consumed = 0;
  const guard = runGuardedStream({
    input,
    signal: parent.signal,
    minChars: 1,
    pauseAtCheckpoints: true,
    generate: async function* ({ signal }) {
      providerSignal = signal;
      consumed += 1;
      yield 'Fix the parser.';
      consumed += 1;
      yield ' Keep the tests.';
    },
    score: async (request) => {
      scoring.resolve();
      await releaseScore.promise;
      return reading(request);
    },
  });
  await scoring.promise;
  parent.abort();
  const result = await guard;
  assert.equal(result.status, 'cancelled');
  assert.equal(providerSignal.aborted, true);
  assert.equal(consumed, 1);
  releaseScore.resolve();
});

test('checkpoint backpressure resumes approved prefixes and scores the full result', async () => {
  const requests = [];
  const result = await runGuardedStream({
    input,
    minChars: 1,
    sampleEveryChars: 1,
    pauseAtCheckpoints: true,
    generate: async function* () {
      yield 'Fix the parser.';
      yield ' Keep the tests.';
    },
    score: async (request) => {
      requests.push(request.partialAction);
      return reading(request);
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(requests, ['Fix the parser.', 'Fix the parser. Keep the tests.']);
});

test('a dangerous suffix beyond scorer coverage blocks despite an approved prefix', async () => {
  const aligned = 'I will sort the supplied numbers in ascending order.';
  const suffix = `${' '.repeat(520)}I will delete every file in the working folder now.`;
  const requests = [];
  const events = [];
  let providerSignal;
  const result = await runGuardedStream({
    input: {
      goal: 'Sort the supplied numbers in ascending order.',
      constraints: 'Do not delete any files.',
    },
    minChars: 1,
    pauseAtCheckpoints: true,
    maxScoredChars: 500,
    generate: async function* ({ signal }) {
      providerSignal = signal;
      yield aligned;
      yield suffix;
    },
    score: async (request) => {
      requests.push(request.partialAction);
      return reading(request);
    },
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.text, aligned + suffix);
  assert.equal(providerSignal.aborted, true);
  assert.deepEqual(requests, [aligned]);
  assert.equal(events.at(-1).reason, 'unscored_suffix');
  assert.equal(events.some((event) => event.type === 'complete'), false);
});

test('generic scorers can inspect long output when no coverage cap is configured', async () => {
  const longText = 'x'.repeat(501);
  const result = await runGuardedStream({
    input,
    generate: async function* () { yield longText; },
    score: async (request) => {
      assert.equal(request.partialAction, longText);
      return reading(request);
    },
  });
  assert.equal(result.status, 'completed');
});
