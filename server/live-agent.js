import { performance } from 'node:perf_hooks';
import { createGenerator, generatorStatus } from './generator.js';
import { runGuardedStream } from '../src/stream-guard.js';

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Expected a task brief.');
  const limits = { goal: 500, constraints: 350, disturbance: 350 };
  for (const [key, max] of Object.entries(limits)) {
    if (typeof input[key] !== 'string' || Buffer.byteLength(input[key], 'utf8') > max ||
        (key !== 'constraints' && !input[key].trim())) {
      throw new Error(`Provide ${key} within ${max} UTF-8 bytes.`);
    }
  }
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Cancelled.'));
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function runComparison({ input, score, onEvent, signal, generatorFactory = createGenerator }) {
  validateInput(input);
  const start = performance.now();
  const emit = (lane, event) => onEvent({ lane, ...event, elapsedMs: performance.now() - start });
  const baselineGenerate = generatorFactory(input, (event) => emit('unguarded', event));
  const guardedGenerate = generatorFactory(input, (event) => emit('guarded', event));
  const scorerInput = { goal: input.goal, constraints: input.constraints, history: [], profile: 'early', goalVersion: 1 };
  let text = '';
  emit('unguarded', { type: 'start', attempt: 0 });
  for await (const delta of baselineGenerate({ signal, adjustment: null, attempt: 0 })) {
    text += delta;
    emit('unguarded', { type: 'delta', delta, text, attempt: 0 });
  }
  const decision = Buffer.byteLength(text, 'utf8') <= 500 ? await abortable(score({ ...scorerInput, partialAction: text, requestId: 'unguarded-final', verifyRequirements: true }), signal) : null;
  const unguarded = { status: 'completed', text, decision };
  if (decision) emit('unguarded', { type: 'reading', decision, text, attempt: 0 });
  emit('unguarded', { type: 'complete', ...unguarded, attempt: 0 });
  const guarded = await runGuardedStream({
    generate: guardedGenerate,
    score,
    finalScore: (snapshot) => score({ ...snapshot, verifyRequirements: true }),
    input: scorerInput,
    onEvent: (event) => emit('guarded', event),
    signal,
    maxCorrections: 1,
    minChars: 32,
    sampleEveryChars: 40,
    pauseAtCheckpoints: true,
    maxScoredChars: 500,
  });
  const result = { unguarded, guarded, model: 'Qwen3 0.6B', profile: 'early' };
  onEvent({ type: 'result', result, elapsedMs: performance.now() - start });
  return result;
}

export function attachLiveAgent(server, bridge, readInput, send) {
  let running = false;
  server.middlewares.use('/api/generator', async (req, res) => {
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
    send(res, 200, await generatorStatus());
  });
  server.middlewares.use('/api/duel', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
    if (running) return send(res, 429, { error: 'A live comparison is already running. Try again after it finishes.' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('The comparison exceeded 90 seconds.')), 90_000);
    res.on('close', () => controller.abort());
    running = true;
    try {
      const input = await abortable(readInput(req), controller.signal);
      validateInput(input);
      await abortable(bridge.ready(), controller.signal);
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      await runComparison({
        input,
        score: (snapshot) => bridge.score(snapshot),
        signal: controller.signal,
        onEvent: (event) => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); },
      });
    } catch (error) {
      if (!res.destroyed) {
        if (!res.headersSent) send(res, error.status || 400, { error: error.message });
        else res.write(`${JSON.stringify({ type: 'error', error: error.message })}\n`);
      }
    } finally {
      clearTimeout(timeout);
      running = false;
      res.end();
    }
  });
}
