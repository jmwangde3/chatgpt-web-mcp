import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Fanout } from '../src/core/fanout.js';

test('fans out concurrently, replays across restart and observes without sending', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fanout-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = { providers: ['chatgpt', 'gemini'], request_id: 'comparison', prompt: 'Synthetic test' };
  const tasks = new Map();
  let sends = 0, inflight = 0, peak = 0;
  let blocked = true;
  const reads = [];
  const kernel = {
    directory, verifyStorage: async () => {}, provider: provider => assert.ok(input.providers.includes(provider)),
    findRequest: async (provider, id) => tasks.get(id),
    async send({ provider, request_id }) {
      sends++;
      inflight++;
      peak = Math.max(peak, inflight);
      await nextTurn();
      inflight--;
      if (provider === 'gemini' && blocked) throw Object.assign(new Error('offline'), { code: 'CONTROL_BUSY' });
      const task = { provider, task_id: provider + ':fixture', state: 'submitted' };
      tasks.set(request_id, task);
      return task;
    },
    async result(id, { timeoutMs }) {
      reads.push(timeoutMs);
      return { task_id: id, state: 'completed' };
    },
  };
  const first = await new Fanout(kernel).send(input);
  assert.equal(peak, 2);
  assert.deepEqual(first.providers.map(child => child.state), ['submitted', 'unavailable']);
  const restarted = new Fanout(kernel);
  const partial = await restarted.result(first.task_id, { timeoutMs: 5000 });
  assert.equal(sends, 2);
  assert.deepEqual(partial.providers.map(child => child.state), ['completed', 'queued']);
  blocked = false;
  assert.equal((await restarted.send(input)).task_id, first.task_id);
  assert.equal(sends, 3);
  await assert.rejects(restarted.send({ ...input, prompt: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await restarted.send({ ...input, providers: [...input.providers].reverse() });
  assert.equal(sends, 3);
  assert.ok((await restarted.result(first.task_id, { timeoutMs: 5000 })).all_succeeded);
  assert.equal(reads.length, 3);
  assert.ok(reads.every(timeout => timeout <= 5000 && timeout >= 1000));
  assert.ok(!(await fs.readFile(restarted.file(first.task_id), 'utf8')).includes(input.prompt));
});
