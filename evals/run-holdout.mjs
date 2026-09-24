import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { NativeBridge } from '../native/bridge.js';
import { inferSignals, loadClassifier, MODEL_ID, MODEL_REVISION } from '../src/semantic-model.js';
import { makeDecision } from '../src/scorer-core.js';

const LABELS = ['continue', 'pivot', 'uncertain'];
const FROZEN_CORPUS_SHA256 = 'e6562e059201fc57d1c6da5658dea6eebc08faaeb748ac1c02c967a36119d74b';

function options(args) {
  const result = { backend: 'cpp', profile: 'conservative', json: false, binary: null, sourceRef: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (['--backend', '--profile', '--binary', '--source-ref'].includes(arg) &&
        (!args[index + 1] || args[index + 1].startsWith('--'))) {
      throw new Error(`${arg} requires a value.`);
    }
    if (arg === '--backend') result.backend = args[++index];
    else if (arg === '--profile') result.profile = args[++index];
    else if (arg === '--binary') result.binary = resolve(args[++index]);
    else if (arg === '--source-ref') result.sourceRef = args[++index];
    else if (arg === '--json') result.json = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!['cpp', 'js'].includes(result.backend)) throw new Error('Use --backend cpp or --backend js.');
  if (!['conservative', 'early'].includes(result.profile)) throw new Error('Use --profile conservative or --profile early.');
  if (result.binary && result.backend !== 'cpp') throw new Error('--binary requires the cpp backend.');
  if (result.sourceRef && result.backend !== 'js') throw new Error('--source-ref requires the js backend.');
  return result;
}

async function loadSource(ref) {
  if (!ref) return { inferSignals, loadClassifier, makeDecision, dispose: async () => {} };
  if (!/^[a-zA-Z0-9_./-]+$/.test(ref) || ref.startsWith('-')) throw new Error('Invalid Git source ref.');
  const execute = promisify(execFile);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const directory = await mkdtemp(join(tmpdir(), 'driftline-holdout-'));
  try {
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'));
    for (const name of ['semantic-model', 'scorer-core']) {
      const { stdout } = await execute('git', ['show', `${ref}:src/${name}.js`], { cwd: root });
      await writeFile(join(directory, `${name}.mjs`), stdout);
    }
    const semantic = await import(pathToFileURL(join(directory, 'semantic-model.mjs')).href);
    const policy = await import(pathToFileURL(join(directory, 'scorer-core.mjs')).href);
    return { ...semantic, ...policy, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function corpusInputs(corpus, profile) {
  if (corpus.version !== 1 || !Array.isArray(corpus.cases) || !corpus.cases.length) {
    throw new Error('Expected a nonempty version 1 corpus.');
  }
  const ids = new Set();
  return corpus.cases.flatMap((scenario) => {
    if (!scenario.id || ids.has(scenario.id) || typeof scenario.goal !== 'string' ||
        !scenario.goal.trim() || !Array.isArray(scenario.snapshots) || !scenario.snapshots.length) {
      throw new Error(`Invalid scenario ${scenario.id}`);
    }
    ids.add(scenario.id);
    return scenario.snapshots.map((snapshot, index) => {
      if (!LABELS.includes(snapshot.gold) || typeof snapshot.partialAction !== 'string' || !snapshot.partialAction.trim()) {
        throw new Error(`Invalid snapshot ${scenario.id} ${index}`);
      }
      return {
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
      };
    });
  });
}

function validateDecision(result, input) {
  if (!LABELS.includes(result.kind)) throw new Error('Invalid decision kind.');
  for (const [name, value] of Object.entries({ confidence: result.confidence, driftScore: result.driftScore })) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid ${name}.`);
  }
  if (result.goalVersion !== input.goalVersion || result.requestId !== input.requestId) {
    throw new Error('The scorer lost request identity.');
  }
  if (!Number.isFinite(result.latencyMs) || result.latencyMs < 0) throw new Error('Invalid scorer latency.');
  if (result.kind === 'pivot' ? typeof result.adjustment !== 'string' || !result.adjustment.trim() : result.adjustment !== null) {
    throw new Error('Invalid adjustment contract.');
  }
}

function summarize(rows) {
  const matrix = Object.fromEntries(LABELS.map((gold) => [gold,
    Object.fromEntries(LABELS.map((predicted) => [predicted, 0]))]));
  for (const row of rows) matrix[row.gold][row.predicted] += 1;
  const count = (fn) => rows.filter(fn).length;
  const truePivots = matrix.pivot.pivot;
  const predictedPivots = count((row) => row.predicted === 'pivot');
  const goldPivots = count((row) => row.gold === 'pivot');
  return {
    matrix,
    snapshots: rows.length,
    truePivots,
    predictedPivots,
    goldPivots,
    pivotPrecision: predictedPivots ? truePivots / predictedPivots : null,
    pivotRecall: goldPivots ? truePivots / goldPivots : null,
    falsePivots: predictedPivots - truePivots,
    nonPivotSnapshots: rows.length - goldPivots,
    exactMatches: count((row) => row.gold === row.predicted),
    abstentions: count((row) => row.predicted === 'uncertain'),
    highConfidenceErrors: count((row) => row.predicted !== 'uncertain' && row.gold !== row.predicted && row.confidence >= 0.9),
  };
}

function printReport(report) {
  const { metrics } = report;
  console.log(`Backend ${report.backend}`);
  console.log(`Profile ${report.profile}`);
  console.log(`Source ${report.sourceRef ?? 'working tree'}`);
  console.log(`Corpus SHA256 ${report.corpusSha256}`);
  console.log(`Corpus ${report.scenarios} scenarios and ${metrics.snapshots} snapshots`);
  console.log('Gold rows, predicted columns   continue  pivot  uncertain');
  for (const [gold, counts] of Object.entries(metrics.matrix)) {
    console.log(`${gold.padEnd(30)} ${String(counts.continue).padStart(8)} ${String(counts.pivot).padStart(6)} ${String(counts.uncertain).padStart(10)}`);
  }
  console.log(`Pivots detected ${metrics.truePivots}/${metrics.goldPivots}`);
  console.log(`Pivot precision ${metrics.truePivots}/${metrics.predictedPivots}`);
  console.log(`False pivots ${metrics.falsePivots}/${metrics.nonPivotSnapshots}`);
  console.log(`Exact label matches ${metrics.exactMatches}/${metrics.snapshots}`);
  console.log(`Uncertain responses ${metrics.abstentions}/${metrics.snapshots}`);
  console.log(`Incorrect committed labels with confidence at least 0.9  ${metrics.highConfidenceErrors}`);
  console.log(`Startup ${report.startupMs.toFixed(1)} ms`);
  console.log('Mismatch details');
  for (const row of report.rows.filter((item) => item.gold !== item.predicted)) {
    console.log(`${row.id}  expected ${row.gold}  got ${row.predicted}  confidence ${row.confidence.toFixed(3)}`);
  }
  console.log('These frozen hand authored challenges do not estimate population accuracy.');
  console.log('Confidence values are model scores and have not been calibrated as probabilities.');
  console.log('Exit status checks the data and response contracts, not a target accuracy.');
}

async function main() {
  const config = options(process.argv.slice(2));
  const corpusText = await readFile(new URL('./holdout.json', import.meta.url));
  const corpusSha256 = createHash('sha256').update(corpusText).digest('hex');
  if (corpusSha256 !== FROZEN_CORPUS_SHA256) throw new Error('Frozen corpus changed. Restore the original corpus rather than revising labels after scoring.');
  const corpus = JSON.parse(corpusText);
  const inputs = corpusInputs(corpus, config.profile);
  const bridge = config.backend === 'cpp' ? new NativeBridge() : null;
  if (bridge && config.binary) bridge.binary = config.binary;
  const binarySha256 = bridge ? createHash('sha256').update(await readFile(bridge.binary)).digest('hex') : null;
  const source = await loadSource(config.sourceRef);
  try {
    const started = performance.now();
    const classifier = bridge ? (await bridge.ready(), null) : await source.loadClassifier();
    const startupMs = performance.now() - started;
    const rows = [];
    for (const entry of inputs) {
      const start = performance.now();
      let decision;
      if (bridge) decision = await bridge.score(entry.input);
      else {
        const signals = await source.inferSignals(classifier, entry.input);
        decision = source.makeDecision(entry.input, signals, performance.now() - start);
      }
      validateDecision(decision, entry.input);
      rows.push({
        id: entry.id,
        gold: entry.gold,
        predicted: decision.kind,
        confidence: decision.confidence,
        latencyMs: decision.latencyMs,
        signals: decision.signals,
      });
    }
    const report = {
      backend: config.backend,
      profile: config.profile,
      sourceRef: config.sourceRef,
      runtime: { node: process.version, platform: process.platform, architecture: process.arch },
      binarySha256,
      model: MODEL_ID,
      modelRevision: MODEL_REVISION,
      corpusSha256,
      scenarios: corpus.cases.length,
      startupMs,
      metrics: summarize(rows),
      rows,
    };
    if (config.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
  } finally {
    bridge?.dispose();
    await source.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
