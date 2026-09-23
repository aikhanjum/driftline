export class DriftScorer {
  constructor() {
    this.worker = new Worker(new URL('./scorer.worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 0;
    this.isReady = false;
    this.progress = () => {};
    this.readyPromise = null;
    this.worker.onmessage = ({ data }) => this.handleMessage(data);
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'The local model worker failed.');
      this.rejectReady?.(error);
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
  }

  ready(onProgress = () => {}) {
    this.progress = onProgress;
    if (this.isReady) return Promise.resolve();
    if (!this.readyPromise) {
      this.readyPromise = new Promise((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
      this.worker.postMessage({ type: 'init' });
    }
    return this.readyPromise;
  }

  async score(input) {
    await this.ready(this.progress);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, sentAt: performance.now() });
      this.worker.postMessage({ type: 'score', id, input });
    });
  }

  handleMessage(data) {
    if (data?.type === 'progress') {
      this.progress(data);
      return;
    }
    if (data?.type === 'ready') {
      this.isReady = true;
      this.resolveReady?.();
      return;
    }
    if (data?.type === 'init_error') {
      this.rejectReady?.(new Error(data.message));
      return;
    }
    const entry = this.pending.get(data?.id);
    if (!entry) return;
    this.pending.delete(data.id);
    if (data.type === 'result') {
      entry.resolve({ ...data.result, roundTripMs: performance.now() - entry.sentAt });
    } else if (data.type === 'superseded') {
      entry.reject(new Error('Superseded by a newer partial action.'));
    } else if (data.type === 'score_error') {
      entry.reject(new Error(data.message));
    }
  }

  dispose() {
    this.worker.terminate();
    for (const entry of this.pending.values()) {
      entry.reject(new Error('Scorer disposed.'));
    }
    this.pending.clear();
  }
}
