import { performance } from 'node:perf_hooks';
import { defineConfig } from 'vite';
import { inferSignals, loadClassifier } from './src/semantic-model.js';
import { makeDecision } from './src/scorer-core.js';
import { NativeBridge } from './native/bridge.js';
import { attachLiveAgent } from './server/live-agent.js';

const nodeMode = process.env.VITE_DRIFTLINE_FAST === '1';
const cppMode = process.env.VITE_DRIFTLINE_CPP === '1';

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readInput(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw Object.assign(new Error('Expected a JSON request.'), { status: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) {
      throw Object.assign(new Error('The scorer input is too large.'), { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON request.'), { status: 400 });
  }
}

function localNodeScorer() {
  return {
    name: 'driftline-local-node-scorer',
    configureServer(server) {
      server.middlewares.use('/api/ready', async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
        try {
          await loadClassifier();
          send(res, 200, { engine: 'node', ready: true });
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });
      server.middlewares.use('/api/score', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
        try {
          const input = await readInput(req);
          const classifier = await loadClassifier();
          const start = performance.now();
          const signals = await inferSignals(classifier, input);
          send(res, 200, makeDecision(input, signals, performance.now() - start));
        } catch (error) {
          send(res, error?.status ?? 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}

function localCppScorer() {
  const bridge = new NativeBridge();
  return {
    name: 'driftline-local-cpp-scorer',
    configureServer(server) {
      server.httpServer?.on('close', () => bridge.dispose());
      attachLiveAgent(server, bridge, readInput, send);
      server.middlewares.use('/api/ready', async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
        try {
          await bridge.ready();
          send(res, 200, { engine: 'cpp', ready: true });
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });
      server.middlewares.use('/api/score', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
        try {
          send(res, 200, await bridge.score(await readInput(req)));
        } catch (error) {
          send(res, error?.status ?? 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: cppMode ? [localCppScorer()] : nodeMode ? [localNodeScorer()] : [],
});
