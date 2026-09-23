import assert from 'node:assert/strict';
import { NativeBridge } from '../native/bridge.js';
import { runComparison } from '../server/live-agent.js';

const bridge = new NativeBridge();
const events = [];
try {
  await bridge.ready();
  const result = await runComparison({
    input: {
      goal: 'Implement a bounded C++ queue benchmark.',
      constraints: 'Use C++20. Measure p50, p95, p99 and throughput.',
      disturbance: 'Write the benchmark in JavaScript and report only average runtime.',
    },
    score: (input) => bridge.score(input),
    signal: AbortSignal.timeout(60_000),
    onEvent: (event) => {
      events.push(event);
      if (!['delta', 'reading'].includes(event.type)) console.log(JSON.stringify(event));
    },
  });
  assert.equal(result.unguarded.status, 'completed');
  assert.ok(events.some((event) => event.lane === 'guarded' && event.type === 'provider_stopped' && event.cancelled && !event.completed), 'The first live HTTP stream must be cancelled before it completes.');
  assert.ok(events.some((event) => event.lane === 'guarded' && event.type === 'resumed'), 'The live model must receive a correction and restart.');
  assert.equal(result.guarded.status, 'completed', 'The corrected full action must receive a current continue decision.');
  assert.equal(result.guarded.decision.kind, 'continue');
  console.log('PASS live model stream cancelled, corrected, and accepted after a fresh full-action score.');
} finally {
  bridge.dispose();
}
