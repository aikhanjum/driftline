import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const revision = '2a4f614a701367a02d51389039afc998faeda637';

export class NativeBridge {
  constructor(root = process.cwd(), { spawnProcess = spawn } = {}) {
    this.root = root;
    this.spawnProcess = spawnProcess;
    this.binary = join(root, 'build/native/driftline_scorer');
    const modelRoot = join(root, `.cache/Xenova/nli-deberta-v3-xsmall/${revision}`);
    this.model = join(modelRoot, 'onnx/model_int8.onnx');
    this.spm = join(modelRoot, 'spm.model');
    this.pending = [];
    this.buffer = '';
    this.readyPromise = null;
    this.child = null;
    this.disposed = false;
  }

  ready() {
    if (this.disposed) return Promise.reject(new Error('Native scorer has been disposed.'));
    if (this.readyPromise) return this.readyPromise;
    const ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyPromise = ready;
    try {
      for (const path of [this.binary, this.model, this.spm]) {
        if (!existsSync(path)) {
          throw new Error(`Missing ${path}. Run npm run setup:cpp first.`);
        }
      }
      const child = this.spawnProcess(this.binary, [this.model, this.spm], { cwd: this.root });
      this.child = child;
      child.stdin.on('error', (error) => this.fail(error, child));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.onData(chunk, child));
      child.stdout.on('error', (error) => this.fail(error, child));
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.stderr.on('error', (error) => this.fail(error, child));
      child.on('error', (error) => this.fail(error, child));
      child.on('exit', (code) => this.fail(new Error(stderr.trim() || `Native scorer exited with code ${code}.`), child));
    } catch (error) {
      this.fail(error, this.child);
    }
    return ready;
  }

  onData(chunk, child) {
    if (child !== this.child) return;
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let result;
      try { result = JSON.parse(line); } catch (error) { this.fail(error, child); return; }
      if (result.type === 'ready') {
        this.resolveReady?.();
        this.resolveReady = null;
        this.rejectReady = null;
      } else {
        const next = this.pending.shift();
        if (!next) { this.fail(new Error('Unsolicited native scorer response.'), child); return; }
        if (result.error) next.reject(new Error(result.error));
        else next.resolve(result);
      }
    }
  }

  async score(input) {
    await this.ready();
    // Serialize before queueing so a malformed caller input cannot shift FIFO
    // responses onto the wrong request.
    const line = `${JSON.stringify(input)}\n`;
    const child = this.child;
    if (!child || this.disposed) throw new Error('Native scorer is unavailable.');
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      try {
        child.stdin.write(line, (error) => {
          if (error) this.fail(error, child);
        });
      } catch (error) {
        this.fail(error, child);
      }
    });
  }

  fail(error, child) {
    if (child !== this.child) return;
    this.child = null;
    this.readyPromise = null;
    this.buffer = '';
    this.rejectReady?.(error);
    this.rejectReady = null;
    this.resolveReady = null;
    for (const entry of this.pending.splice(0)) entry.reject(error);
    child?.kill();
  }

  dispose() {
    this.disposed = true;
    this.fail(new Error('Native scorer has been disposed.'), this.child);
  }
}
