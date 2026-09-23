import test from 'node:test';
import assert from 'node:assert/strict';
import { PivotGate } from '../src/pivot-gate.js';

function pivot(overrides = {}) {
  return {
    kind: 'pivot',
    confidence: 0.94,
    adjustment: 'Pause this action and return to the user goal.',
    goalVersion: 7,
    requestId: 'score-1',
    ...overrides,
  };
}

test('a current high-confidence pivot redirects during model generation', () => {
  const calls = [];
  const gate = new PivotGate({
    onRedirect: (adjustment, decision) => calls.push({ adjustment, decision }),
    onSteer: () => assert.fail('The tool handler must not run during model generation.'),
  });
  gate.setContext({ goalVersion: 7, requestId: 'score-1', phase: 'model' });
  const decision = pivot();

  assert.deepEqual(gate.apply(decision), { applied: true, reason: 'redirected' });
  assert.deepEqual(calls, [{ adjustment: decision.adjustment, decision }]);
});

test('a current high-confidence pivot steers during a tool action', () => {
  const calls = [];
  const gate = new PivotGate({
    onRedirect: () => assert.fail('The model handler must not run during a tool action.'),
    onSteer: (adjustment, decision) => calls.push({ adjustment, decision }),
  });
  gate.setContext({ goalVersion: 7, requestId: 'score-1', phase: 'tool' });
  const decision = pivot();

  assert.deepEqual(gate.apply(decision), { applied: true, reason: 'steered' });
  assert.deepEqual(calls, [{ adjustment: decision.adjustment, decision }]);
});

test('a result for an old goal revision cannot apply', async () => {
  const calls = [];
  const gate = new PivotGate({ onRedirect: () => calls.push('redirect') });
  gate.setContext({ goalVersion: 7, requestId: 'score-1', phase: 'model' });
  const pendingResult = Promise.resolve().then(() => gate.apply(pivot()));
  gate.setContext({ goalVersion: 8, requestId: 'score-1', phase: 'model' });

  assert.deepEqual(await pendingResult, { applied: false, reason: 'stale' });
  assert.deepEqual(calls, []);
});

test('an older partial-action request cannot apply after a newer one arrives', async () => {
  const calls = [];
  const gate = new PivotGate({ onSteer: () => calls.push('steer') });
  gate.setContext({ goalVersion: 7, requestId: 'score-1', phase: 'tool' });
  const pendingResult = Promise.resolve().then(() => gate.apply(pivot()));
  gate.setContext({ goalVersion: 7, requestId: 'score-2', phase: 'tool' });

  assert.deepEqual(await pendingResult, { applied: false, reason: 'stale' });
  assert.deepEqual(calls, []);
});

test('uncertain, continuing, and weak pivot decisions cannot trigger a handler', () => {
  const calls = [];
  const gate = new PivotGate({ onRedirect: () => calls.push('redirect'), threshold: 0.8 });
  gate.setContext({ goalVersion: 7, requestId: 'score-1', phase: 'model' });

  assert.deepEqual(gate.apply(pivot({ kind: 'uncertain', adjustment: null })), { applied: false, reason: 'no_pivot' });
  assert.deepEqual(gate.apply(pivot({ kind: 'continue', adjustment: null })), { applied: false, reason: 'no_pivot' });
  assert.deepEqual(gate.apply(pivot({ confidence: 0.79 })), { applied: false, reason: 'low_confidence' });
  assert.deepEqual(gate.apply(pivot({ adjustment: null })), { applied: false, reason: 'low_confidence' });
  assert.deepEqual(calls, []);
});
