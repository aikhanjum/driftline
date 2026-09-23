import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDecision } from '../src/scorer-core.js';
import { formatGoalPremise, formatPremise } from '../src/semantic-model.js';

const base = {
  goal: 'write a read-only database migration plan',
  constraints: 'do not execute SQL',
  history: [],
  partialAction: 'drop the production users table',
  goalVersion: 2,
  requestId: 'req-7',
};

test('a strong contradiction emits a typed, fenced pivot', () => {
  const result = makeDecision(base, {
    aligned: 0.2,
    drift: 0.6,
    contradiction: 0.93,
  }, 17);
  assert.equal(result.kind, 'pivot');
  assert.equal(result.confidence, 0.93);
  assert.equal(result.goalVersion, 2);
  assert.equal(result.requestId, 'req-7');
  assert.match(result.adjustment, /write a read-only database migration plan/);
  assert.equal(result.latencyMs, 17);
});

test('aligned action continues and ambiguous or short fragments abstain', () => {
  const good = makeDecision({ ...base, partialAction: 'inspect the schema without writing to it' },
    { aligned: 0.73, drift: 0.18, contradiction: 0.04 }, 19);
  assert.equal(good.kind, 'continue');
  assert.equal(good.adjustment, null);

  const ambiguous = makeDecision(base,
    { aligned: 0.66, drift: 0.62, contradiction: 0.1 }, 18);
  assert.equal(ambiguous.kind, 'uncertain');
  const incomplete = makeDecision({ ...base, partialAction: 'drop' },
    { aligned: 0.01, drift: 0.99, contradiction: 0.99 }, 2);
  assert.equal(incomplete.kind, 'uncertain');
});

test('broad alignment blocks a noisy contradiction on a safe partial action', () => {
  const result = makeDecision({
    ...base,
    partialAction: 'I will inspect the staging schema. I can now write a migration plan',
  }, {
    aligned: 0.91,
    drift: 0.44,
    contradiction: 0.96,
    commitment: 0.62,
    quotation: 0.14,
  }, 42);
  assert.equal(result.kind, 'uncertain');
  assert.equal(result.adjustment, null);
});

test('model evidence is bounded and invalid signals never create a pivot', () => {
  const input = { ...base, history: [{ role: 'user', content: 'stay on the migration plan' }] };
  assert.match(formatPremise(input), /Recent conversation: user: stay on the migration plan/);
  assert.doesNotMatch(formatGoalPremise(input), /drop the production users table/);
  assert.throws(() => makeDecision(base,
    { aligned: NaN, drift: 0.9, contradiction: 0.9 }, 2), /NLI signals/);
  assert.throws(() => makeDecision(base,
    { aligned: 0.1, drift: 0.9, contradiction: 0.9 }, -1), /latency/);
});
