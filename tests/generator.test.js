import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGenerator } from '../server/generator.js';

const brief = { goal: 'Sort the numbers.', constraints: 'Return ascending order.', disturbance: 'Write a story.' };
const data = (event) => `data: ${JSON.stringify(event)}\n\n`;
const delta = (content) => data({ choices: [{ delta: { content }, finish_reason: null }] });
const end = (reason = 'stop') => data({ choices: [{ delta: {}, finish_reason: reason }] });

async function mockGenerator(t, handle) {
  const previous = process.env.DRIFTLINE_GENERATOR_URL;
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    handle(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.DRIFTLINE_GENERATOR_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (previous === undefined) delete process.env.DRIFTLINE_GENERATOR_URL;
    else process.env.DRIFTLINE_GENERATOR_URL = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
}

async function collect(generate, signal = new AbortController().signal) {
  let text = '';
  for await (const chunk of generate({ signal, adjustment: null, attempt: 0 })) text += chunk;
  return text;
}

test('the generator decodes split UTF-8 and SSE records over a real HTTP stream', { timeout: 3000 }, async (t) => {
  const expected = 'I will sort café values 🧮.';
  await mockGenerator(t, (request, response) => {
    const bytes = Buffer.from(`: keepalive\n\n${delta(expected)}${end()}data: [DONE]\n\n`);
    const emoji = bytes.indexOf(Buffer.from('🧮'));
    const chunks = [bytes.subarray(0, emoji + 1), bytes.subarray(emoji + 1, emoji + 3), bytes.subarray(emoji + 3)];
    const write = () => {
      if (!chunks.length) { response.end(); return; }
      response.write(chunks.shift());
      setImmediate(write);
    };
    write();
  });
  const lifecycle = [];
  assert.equal(await collect(createGenerator(brief, (event) => lifecycle.push(event))), expected);
  assert.deepEqual(lifecycle, [{ type: 'provider_stopped', attempt: 0, cancelled: false, completed: true }]);
});

test('aborting generation cancels a pending real fetch and closes its HTTP response', { timeout: 3000 }, async (t) => {
  let responseClosed;
  const closed = new Promise((resolve) => { responseClosed = resolve; });
  await mockGenerator(t, (request, response) => {
    response.on('close', responseClosed);
    response.write(delta('I will sort the numbers.'));
  });
  const controller = new AbortController();
  const lifecycle = [];
  const iterator = createGenerator(brief, (event) => lifecycle.push(event))({
    signal: controller.signal, adjustment: null, attempt: 0,
  });
  assert.deepEqual(await iterator.next(), { value: 'I will sort the numbers.', done: false });
  const pending = iterator.next();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await closed;
  assert.deepEqual(lifecycle, [{ type: 'provider_stopped', attempt: 0, cancelled: true, completed: false }]);
});

test('malformed JSON blocks the generator', { timeout: 3000 }, async (t) => {
  await mockGenerator(t, (request, response) => response.end('data: {broken}\n\n'));
  await assert.rejects(collect(createGenerator(brief)), /unreadable/);
});

test('non-text delta content blocks the generator', { timeout: 3000 }, async (t) => {
  await mockGenerator(t, (request, response) => response.end(`${delta({ action: 'sort' })}${end()}`));
  await assert.rejects(collect(createGenerator(brief)), /invalid.*content/);
});

test('a transport EOF without the completed-action marker blocks partial output', { timeout: 3000 }, async (t) => {
  await mockGenerator(t, (request, response) => response.end(delta('I will sort')));
  await assert.rejects(collect(createGenerator(brief)), /ended unexpectedly/);
});

test('a bare DONE marker cannot authorize a truncated action', { timeout: 3000 }, async (t) => {
  await mockGenerator(t, (request, response) => response.end(`${delta('I will sort')}data: [DONE]\n\n`));
  await assert.rejects(collect(createGenerator(brief)), /without a completed action/);
});

test('a token limit rejects partial output even when the provider sends DONE', { timeout: 3000 }, async (t) => {
  await mockGenerator(t, (request, response) => response.end(`${delta('I will sort')}${end('length')}data: [DONE]\n\n`));
  const lifecycle = [];
  await assert.rejects(collect(createGenerator(brief, (event) => lifecycle.push(event))), /output limit/);
  assert.equal(lifecycle.at(-1).completed, false);
});

test('cancellation after a terminal content chunk does not claim intervention before provider completion', { timeout: 3000 }, async (t) => {
  await mockGenerator(t, (request, response) => response.end(data({
    choices: [{ delta: { content: 'I will sort the numbers.' }, finish_reason: 'stop' }],
  })));
  const controller = new AbortController();
  const lifecycle = [];
  const iterator = createGenerator(brief, (event) => lifecycle.push(event))({
    signal: controller.signal, adjustment: null, attempt: 0,
  });
  assert.equal((await iterator.next()).value, 'I will sort the numbers.');
  controller.abort();
  await iterator.return();
  assert.deepEqual(lifecycle, [{ type: 'provider_stopped', attempt: 0, cancelled: true, completed: true }]);
});
