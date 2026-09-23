import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { NativeBridge } from '../native/bridge.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new EventEmitter();
  child.writes = [];
  child.callbacks = [];
  child.stdin.write = (line, callback) => {
    child.writes.push(line);
    child.callbacks.push(callback);
    return true;
  };
  child.kills = 0;
  child.kill = () => { child.kills += 1; return true; };
  child.respond = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
  return child;
}

function fixture() {
  const children = [];
  const bridge = new NativeBridge(process.cwd(), {
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  // File existence checks remain real. The injected child never executes or
  // loads these placeholder paths, so tests need no native build or model.
  bridge.binary = bridge.model = bridge.spm = fileURLToPath(import.meta.url);
  return { bridge, children };
}

async function start(bridge, children) {
  const ready = bridge.ready();
  const child = children.at(-1);
  child.respond({ type: 'ready' });
  await ready;
  return child;
}

test('readiness is shared and split protocol lines preserve request order', async () => {
  const { bridge, children } = fixture();
  const ready = bridge.ready();
  assert.equal(bridge.ready(), ready);
  const child = children[0];
  child.stdout.write('{"type":"rea');
  child.stdout.write('dy"}\n');
  await ready;
  const first = bridge.score({ requestId: 'one' });
  const second = bridge.score({ requestId: 'two' });
  await Promise.resolve();
  assert.deepEqual(child.writes.map(JSON.parse), [{ requestId: 'one' }, { requestId: 'two' }]);
  child.respond({ requestId: 'one', kind: 'continue' });
  child.respond({ requestId: 'two', kind: 'uncertain' });
  assert.equal((await first).requestId, 'one');
  assert.equal((await second).requestId, 'two');
  bridge.dispose();
});

test('a crashed scorer rejects pending work and fresh readiness starts another child', async () => {
  const { bridge, children } = fixture();
  const old = await start(bridge, children);
  const pending = bridge.score({ requestId: 'old' });
  const rejected = assert.rejects(pending, /exited with code 7/);
  await Promise.resolve();
  old.stdout.write('{"requestId":');
  old.emit('exit', 7);
  await rejected;
  assert.equal(bridge.readyPromise, null);
  assert.equal(bridge.child, null);
  assert.equal(bridge.buffer, '');

  const ready = bridge.ready();
  const fresh = children[1];
  old.emit('exit', 7);
  old.stdout.write('"old"}\n');
  assert.equal(fresh.kills, 0);
  fresh.respond({ type: 'ready' });
  await ready;
  const scored = bridge.score({ requestId: 'fresh' });
  await Promise.resolve();
  fresh.respond({ requestId: 'fresh', kind: 'continue' });
  assert.equal((await scored).requestId, 'fresh');
  bridge.dispose();
});

test('startup failure can be retried without the old exit killing its replacement', async () => {
  const { bridge, children } = fixture();
  const ready = bridge.ready();
  const rejected = assert.rejects(ready, /spawn failed/);
  children[0].emit('error', new Error('spawn failed'));
  await rejected;
  const replacement = bridge.ready();
  children[0].emit('exit', -1);
  assert.equal(children[1].kills, 0);
  children[1].respond({ type: 'ready' });
  await replacement;
  bridge.dispose();
});

test('a broken stdin handles both write callback and error event without an uncaught error', async () => {
  const { bridge, children } = fixture();
  const child = await start(bridge, children);
  const pending = bridge.score({ requestId: 'broken' });
  const rejected = assert.rejects(pending, /EPIPE/);
  await Promise.resolve();
  const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  child.callbacks[0](error);
  assert.doesNotThrow(() => child.stdin.emit('error', error));
  await rejected;
  assert.equal(child.kills, 1);
  assert.equal(bridge.readyPromise, null);
  bridge.dispose();
});

test('disposal immediately rejects pending work and permanently prevents restart', async () => {
  const { bridge, children } = fixture();
  const child = await start(bridge, children);
  const pending = bridge.score({ requestId: 'pending' });
  const rejected = assert.rejects(pending, /disposed/);
  await Promise.resolve();
  bridge.dispose();
  await rejected;
  assert.equal(child.kills, 1);
  await assert.rejects(bridge.ready(), /disposed/);
  await assert.rejects(bridge.score({ requestId: 'late' }), /disposed/);
  assert.equal(children.length, 1);
});

test('disposal during startup rejects readiness without waiting for a process exit', async () => {
  const { bridge } = fixture();
  const ready = bridge.ready();
  const rejected = assert.rejects(ready, /disposed/);
  bridge.dispose();
  await rejected;
});

test('input serialization failure cannot corrupt the next response assignment', async () => {
  const { bridge, children } = fixture();
  const child = await start(bridge, children);
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(bridge.score(cyclic), /circular/i);
  assert.equal(bridge.pending.length, 0);
  const result = bridge.score({ requestId: 'valid' });
  await Promise.resolve();
  child.respond({ requestId: 'valid', kind: 'continue' });
  assert.equal((await result).requestId, 'valid');
  assert.equal(child.writes.length, 1);
  bridge.dispose();
});
