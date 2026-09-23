import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { loadClassifier, inferSignals, MODEL_ID, MODEL_REVISION, MODEL_DTYPE } from '../src/semantic-model.js';
import { makeDecision } from '../src/scorer-core.js';

const LABELS = ['continue', 'pivot', 'uncertain'];
const DEFAULT_BENCH_RUNS = 200;
const WARMUP_RUNS = 20;

function benchRunsFromArgs(args) {
  const index = args.indexOf('--bench-runs');
  if (index < 0) return DEFAULT_BENCH_RUNS;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 20) {
    throw new Error('--bench-runs must be an integer of at least 20.');
  }
  return value;
}

function validateCorpus(corpus) {
  if (corpus.version !== 1 || !Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    throw new Error('Expected a nonempty version 1 scenario corpus.');
  }
  const ids = new Set();
  for (const scenario of corpus.cases) {
    if (!scenario.id || ids.has(scenario.id) || !scenario.goal || !Array.isArray(scenario.snapshots) || !scenario.snapshots.length) {
      throw new Error(`Invalid or duplicate scenario: ${scenario.id}`);
    }
    ids.add(scenario.id);
    for (const snapshot of scenario.snapshots) {
      if (!snapshot.partialAction || !LABELS.includes(snapshot.gold)) {
        throw new Error(`Invalid snapshot in ${scenario.id}`);
      }
    }
  }
}

function toInput(scenario, snapshot, index) {
  return {
    goal: scenario.goal,
    constraints: (scenario.constraints ?? []).join(' '),
    history: scenario.history ?? [],
    partialAction: snapshot.partialAction,
    goalVersion: 1,
    requestId: `${scenario.id}:${index}`,
  };
}

function validateDecision(decision, input) {
  if (!decision || !LABELS.includes(decision.kind)) throw new Error('Invalid decision kind.');
  for (const [name, value] of Object.entries({
    confidence: decision.confidence,
    driftScore: decision.driftScore,
    aligned: decision.signals?.aligned,
    drift: decision.signals?.drift,
    contradiction: decision.signals?.contradiction,
  })) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid ${name}.`);
  }
  if (!Number.isFinite(decision.latencyMs) || decision.latencyMs < 0) throw new Error('Invalid latencyMs.');
  if (decision.goalVersion !== input.goalVersion || decision.requestId !== input.requestId) {
    throw new Error('Decision lost its goal or request identity.');
  }
  if (decision.kind === 'pivot'
    ? typeof decision.adjustment !== 'string' || !decision.adjustment.trim()
    : decision.adjustment !== null) {
    throw new Error('Decision has an invalid typed adjustment.');
  }
}

async function score(classifier, input) {
  const start = performance.now();
  const signals = await inferSignals(classifier, input);
  const inferenceMs = performance.now() - start;
  const decision = makeDecision(input, signals, inferenceMs);
  const endToEndMs = performance.now() - start;
  validateDecision(decision, input);
  return { decision, endToEndMs };
}

function percentile(sorted, fraction) {
  if (!sorted.length) return NaN;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function countMatrix(rows) {
  const matrix = Object.fromEntries(LABELS.map((label) => [label, Object.fromEntries(LABELS.map((value) => [value, 0]))]));
  for (const row of rows) matrix[row.gold][row.predicted] += 1;
  return matrix;
}

function ratio(numerator, denominator) {
  return denominator ? `${(100 * numerator / denominator).toFixed(1)}%` : 'n/a';
}

function printResults(rows, scenarios, latencies, modelLoadMs, firstScoreMs, benchRuns) {
  const matrix = countMatrix(rows);
  const falsePivots = rows.filter((row) => row.predicted === 'pivot' && row.gold !== 'pivot');
  const truePivots = matrix.pivot.pivot;
  const predictedPivots = rows.filter((row) => row.predicted === 'pivot').length;
  const goldPivots = rows.filter((row) => row.gold === 'pivot').length;
  const detection = scenarios
    .map((scenario) => {
      const firstGold = scenario.snapshots.findIndex((snapshot) => snapshot.gold === 'pivot');
      if (firstGold < 0) return null;
      const firstFound = rows.find((row) => row.caseId === scenario.id && row.index >= firstGold && row.predicted === 'pivot');
      return { id: scenario.id, lag: firstFound ? firstFound.index - firstGold : null };
    })
    .filter(Boolean);
  const sorted = [...latencies].sort((a, b) => a - b);

  console.log(`Model: ${MODEL_ID} @ ${MODEL_REVISION.slice(0, 12)} (${MODEL_DTYPE}, ${process.versions?.node ? 'cpu' : 'wasm'})`);
  console.log(`Runtime: Node ${process.version}, ${process.platform}/${process.arch}`);
  console.log(`Corpus: ${scenarios.length} hand-labeled scenarios, ${rows.length} partial-action snapshots`);
  console.log('');
  console.log('Confusion matrix (gold rows, predicted columns)');
  console.log('                 continue  pivot  uncertain');
  for (const gold of LABELS) {
    console.log(`${gold.padEnd(16)} ${String(matrix[gold].continue).padStart(8)} ${String(matrix[gold].pivot).padStart(6)} ${String(matrix[gold].uncertain).padStart(10)}`);
  }
  console.log(`Pivot precision: ${ratio(truePivots, predictedPivots)} (${truePivots}/${predictedPivots})`);
  console.log(`Pivot recall:    ${ratio(truePivots, goldPivots)} (${truePivots}/${goldPivots})`);
  console.log(`False pivots:    ${falsePivots.length}/${rows.filter((row) => row.gold !== 'pivot').length} non-pivot snapshots`);
  if (falsePivots.length) {
    console.log(`  Cases: ${falsePivots.map((row) => `${row.caseId}#${row.index + 1} (${row.gold})`).join(', ')}`);
  }
  console.log(`Pivot detection lag: ${detection.map((entry) => `${entry.id}=${entry.lag === null ? 'missed' : `${entry.lag} snapshot(s)`}`).join(', ')}`);
  console.log('');
  console.log(`Model load: ${modelLoadMs.toFixed(1)} ms, first inference and decision: ${firstScoreMs.toFixed(1)} ms`);
  console.log(`Warm scorer latency across ${benchRuns} sequential mixed inputs: p50 ${percentile(sorted, 0.5).toFixed(1)} ms, p95 ${percentile(sorted, 0.95).toFixed(1)} ms, p99 ${percentile(sorted, 0.99).toFixed(1)} ms`);
  console.log('Latency includes model inference and decision assembly. Labels are a small hand-authored regression set, not a population accuracy or confidence-calibration estimate.');
}

async function main() {
  const benchRuns = benchRunsFromArgs(process.argv.slice(2));
  const corpus = JSON.parse(await readFile(new URL('./scenarios.json', import.meta.url), 'utf8'));
  validateCorpus(corpus);
  const inputs = corpus.cases.flatMap((scenario) => scenario.snapshots.map((snapshot, index) => ({
    caseId: scenario.id,
    index,
    gold: snapshot.gold,
    input: toInput(scenario, snapshot, index),
  })));
  const loadStart = performance.now();
  const classifier = await loadClassifier();
  const modelLoadMs = performance.now() - loadStart;
  const first = await score(classifier, inputs[0].input);
  const firstScoreMs = first.endToEndMs;

  const rows = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const entry = inputs[index];
    const result = index === 0 ? first : await score(classifier, entry.input);
    rows.push({ caseId: entry.caseId, index: entry.index, gold: entry.gold, predicted: result.decision.kind });
  }

  for (let index = 0; index < WARMUP_RUNS; index += 1) {
    await score(classifier, inputs[index % inputs.length].input);
  }
  const latencies = [];
  for (let index = 0; index < benchRuns; index += 1) {
    const result = await score(classifier, inputs[index % inputs.length].input);
    latencies.push(result.endToEndMs);
  }
  printResults(rows, corpus.cases, latencies, modelLoadMs, firstScoreMs, benchRuns);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
