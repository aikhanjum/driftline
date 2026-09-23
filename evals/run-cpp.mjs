import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { NativeBridge } from '../native/bridge.js';
import { inferSignals, loadClassifier } from '../src/semantic-model.js';
import { makeDecision } from '../src/scorer-core.js';

const corpus = JSON.parse(await readFile(new URL('./scenarios.json', import.meta.url), 'utf8'));
const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex < 0 ? 'conservative' : process.argv[profileIndex + 1];
if (!['conservative', 'early'].includes(profile)) throw new Error('Unknown scoring profile.');
const inputs = corpus.cases.flatMap((scenario) => scenario.snapshots.map((snapshot, index) => ({
  id: `${scenario.id}:${index}`,
  gold: snapshot.gold,
  input: {
    profile,
    goal: scenario.goal,
    constraints: (scenario.constraints ?? []).join(' '),
    history: scenario.history ?? [],
    partialAction: snapshot.partialAction,
    goalVersion: 1,
    requestId: `${scenario.id}:${index}`,
  },
})));

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * fraction;
  const low = Math.floor(rank);
  return sorted[low] + (sorted[Math.ceil(rank)] - sorted[low]) * (rank - low);
}

function matrix(rows) {
  const labels = ['continue', 'pivot', 'uncertain'];
  const counts = Object.fromEntries(labels.map((gold) => [gold,
    Object.fromEntries(labels.map((predicted) => [predicted, 0]))]));
  for (const row of rows) counts[row.gold][row.predicted] += 1;
  return counts;
}

const bridge = new NativeBridge();
try {
  const startup = performance.now();
  await bridge.ready();
  console.log(`C++ model startup ${Math.round(performance.now() - startup)} ms`);
  const classifier = await loadClassifier();
  const rows = [];
  let mismatches = 0;
  for (const { id, gold, input } of inputs) {
    const native = await bridge.score(input);
    if (!['continue', 'pivot', 'uncertain'].includes(native.kind) ||
        native.requestId !== input.requestId || native.goalVersion !== input.goalVersion ||
        !Number.isFinite(native.latencyMs)) {
      throw new Error(`Invalid native response for ${id}`);
    }
    const js = makeDecision(input, await inferSignals(classifier, input), 0);
    rows.push({ id, gold, predicted: native.kind });
    if (native.kind !== js.kind) {
      mismatches += 1;
      console.log(`Parity mismatch ${id}  C++ ${native.kind}  JS ${js.kind}`);
      console.log(`  C++ ${JSON.stringify(native.signals)}  JS ${JSON.stringify(js.signals)}`);
    }
  }
  const counts = matrix(rows);
  console.log(`Corpus ${corpus.cases.length} scenarios, ${rows.length} snapshots`);
  console.log(`Profile ${profile}`);
  console.log('Gold rows, predicted columns   continue  pivot  uncertain');
  for (const [gold, values] of Object.entries(counts)) {
    console.log(`${gold.padEnd(30)} ${String(values.continue).padStart(8)} ${String(values.pivot).padStart(6)} ${String(values.uncertain).padStart(10)}`);
  }
  console.log(`C++ and JS decision mismatches ${mismatches}/${rows.length}`);
  if (!process.argv.includes('--parity-only')) {
    for (let i = 0; i < 20; i += 1) await bridge.score(inputs[i % inputs.length].input);
    const latency = [];
    for (let i = 0; i < 200; i += 1) {
      const started = performance.now();
      await bridge.score(inputs[i % inputs.length].input);
      latency.push(performance.now() - started);
    }
    console.log(`Warm C++ scorer round trip across 200 sequential mixed inputs  p50 ${percentile(latency, 0.5).toFixed(1)} ms, p95 ${percentile(latency, 0.95).toFixed(1)} ms, p99 ${percentile(latency, 0.99).toFixed(1)} ms`);
  }
  if (mismatches) process.exitCode = 1;
} finally {
  bridge.dispose();
}
