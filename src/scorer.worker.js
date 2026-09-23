import { inferSignals, loadClassifier } from './semantic-model.js';
import { makeDecision } from './scorer-core.js';

let classifierPromise;
let queued = null;
let processing = false;

function post(type, fields = {}) {
  self.postMessage({ type, ...fields });
}

function initialize() {
  if (!classifierPromise) {
    classifierPromise = loadClassifier((info) => {
      if (info.status !== 'progress' && info.status !== 'progress_total' &&
          info.status !== 'initiate' && info.status !== 'done') return;
      post('progress', {
        status: info.status,
        file: typeof info.file === 'string' ? info.file : undefined,
        percent: Number.isFinite(info.progress) ? info.progress : undefined,
      });
    }).then((classifier) => {
      post('ready');
      return classifier;
    }).catch((error) => {
      classifierPromise = undefined;
      post('init_error', { message: error instanceof Error ? error.message : String(error) });
      throw error;
    });
  }
  return classifierPromise;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (queued) {
      const job = queued;
      queued = null;
      try {
        const classifier = await initialize();
        const start = performance.now();
        const signals = await inferSignals(classifier, job.input);
        const result = makeDecision(job.input, signals, performance.now() - start);
        post('result', { id: job.id, result });
      } catch (error) {
        post('score_error', {
          id: job.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    processing = false;
  }
}

self.onmessage = ({ data }) => {
  if (data?.type === 'init') {
    initialize().catch(() => {});
    return;
  }
  if (data?.type !== 'score') return;
  if (queued) post('superseded', { id: queued.id });
  queued = { id: data.id, input: data.input };
  processQueue();
};
