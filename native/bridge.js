import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const revision = '2a4f614a701367a02d51389039afc998faeda637';

export class NativeBridge {
  constructor(root = process.cwd()) {
    this.root = root;
    this.binary = join(root, 'build/native/driftline_scorer');
    const modelRoot = join(root, `.cache/Xenova/nli-deberta-v3-xsmall/${revision}`);
    this.model = join(modelRoot, 'onnx/model_int8.onnx');
    this.spm = join(modelRoot, 'spm.model');
    this.pending = [];
    this.buffer = '';
    this.readyPromise = null;
  }

  ready() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      for (const path of [this.binary, this.model, this.spm]) {
        if (!existsSync(path)) {
          reject(new Error(`Missing ${path}. Run npm run setup:cpp first.`));
          return;
        }
      }
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.child = spawn(this.binary, [this.model, this.spm], { cwd: this.root });
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => this.onData(chunk));
      let stderr = '';
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (chunk) => { stderr += chunk; });
      this.child.on('error', (error) => this.fail(error));
      this.child.on('exit', (code) => this.fail(new Error(stderr.trim() || `Native scorer exited with code ${code}.`)));
    }).catch((error) => {
      this.readyPromise = null;
      throw error;
    });
    return this.readyPromise;
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let result;
      try { result = JSON.parse(line); } catch (error) { this.fail(error); return; }
      if (result.type === 'ready') {
        this.resolveReady?.();
        this.resolveReady = null;
      } else {
        const next = this.pending.shift();
        if (!next) { this.fail(new Error('Unsolicited native scorer response.')); return; }
        if (result.error) next.reject(new Error(result.error));
        else next.resolve(result);
      }
    }
  }

  async score(input) {
    await this.ready();
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(`${JSON.stringify(input)}\n`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  fail(error) {
    this.rejectReady?.(error);
    this.rejectReady = null;
    for (const entry of this.pending.splice(0)) entry.reject(error);
    this.child?.kill();
  }

  dispose() {
    this.child?.kill();
  }
}
