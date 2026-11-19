import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskKernel } from '../src/core/tasks.js';

async function fixture(t, provider) {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'web-chat-send-outcome-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), root);
    await fs.rm(directory, { recursive: true, force: true });
  });
  let sends = 0;
  const page = {
    url: 'https://example.com/chat/1', userCount: 0, responseCount: 0,
    lastUser: '', busy: false, complete: false, text: '',
  };
  const adapter = {
    id: provider, stagedSend: true,
    browser: { runExclusive: async fn => fn() },
    isRoot: () => false,
    prepare: async () => ({ ...page }),
    inspect: async () => ({ ...page }),
    settle: async () => {},
    send: async input => { sends++; return adapter.attempt(input); },
  };
  const kernel = new TaskKernel([adapter], { directory, verifyStoragePaths: async () => {} });
  const input = { provider, request_id: 'send-outcome-one', prompt: 'synthetic private prompt' };
  return { kernel, adapter, page, input, directory, sends: () => sends };
}

async function assertReplay(f, task) {
  const restarted = new TaskKernel([f.adapter], { directory: f.directory, verifyStoragePaths: async () => {} });
  for (const kernel of [f.kernel, restarted]) {
    const replay = await kernel.send(f.input);
    assert.equal(replay.task_id, task.task_id);
    assert.equal(replay.replayed, true);
    assert.equal(replay.state, task.state);
    assert.equal(replay.blocking, task.blocking);
    assert.equal(f.sends(), 1);
  }
}

for (const provider of ['chatgpt', 'gemini']) {
  test(`${provider}: both not-attempted markers release a staged reservation after beforeSubmit`, async t => {
    const f = await fixture(t, provider);
    let boundaries = 0;
    f.adapter.attempt = async ({ beforeSubmit }) => {
      await beforeSubmit();
      boundaries++;
      throw Object.assign(new Error('submit was not attempted'), {
        code: 'SEND_NOT_ATTEMPTED', sendOutcome: 'not_attempted',
      });
    };
    const task = await f.kernel.send(f.input);
    assert.equal(boundaries, 1);
    assert.equal(task.state, 'failed');
    assert.equal(task.blocking, false);
    assert.equal(task.error.code, 'SEND_NOT_ATTEMPTED');
    assert.equal((await f.kernel.list(provider)).active_task, null);
    await assertReplay(f, task);
  });

  for (const [label, markers] of [
    ['code only', { code: 'SEND_NOT_ATTEMPTED' }],
    ['outcome only', { sendOutcome: 'not_attempted' }],
  ]) {
    test(`${provider}: ${label} cannot release a staged reservation after beforeSubmit`, async t => {
      const f = await fixture(t, provider);
      f.adapter.attempt = async ({ beforeSubmit }) => {
        await beforeSubmit();
        throw Object.assign(new Error('delivery is not proven'), markers);
      };
      const task = await f.kernel.send(f.input);
      assert.equal(task.state, 'uncertain');
      assert.equal(task.blocking, true);
      assert.equal((await f.kernel.list(provider)).active_task, task.task_id);
      await assertReplay(f, task);
    });
  }

  test(`${provider}: a post-click error remains uncertain and request replay never sends again`, async t => {
    const f = await fixture(t, provider);
    let clicks = 0;
    f.adapter.attempt = async ({ beforeSubmit }) => {
      await beforeSubmit();
      clicks++;
      throw new Error('connection lost after click');
    };
    const task = await f.kernel.send(f.input);
    assert.equal(task.state, 'uncertain');
    assert.equal(task.blocking, true);
    assert.equal((await f.kernel.list(provider)).active_task, task.task_id);
    await assertReplay(f, task);
    assert.equal(clicks, 1);
  });

  test(`${provider}: a mismatched message cannot acknowledge an unconfirmed send`, async t => {
    const f = await fixture(t, provider);
    f.adapter.attempt = async ({ beforeSubmit }) => {
      await beforeSubmit();
      Object.assign(f.page, {
        userCount: 1, lastUser: 'a different message', responseCount: 1,
        complete: true, text: 'answer to a different message',
      });
      throw Object.assign(new Error('acknowledgement delayed'), { code: 'SEND_UNCONFIRMED' });
    };
    const task = await f.kernel.send(f.input);
    assert.equal(task.state, 'uncertain');
    assert.equal(task.blocking, true);
    assert.equal(task.error.code, 'SEND_UNCONFIRMED');
    const result = await f.kernel.result(task.task_id);
    assert.equal(result.state, 'uncertain');
    assert.equal(result.error.code, 'SEND_UNCONFIRMED');
    assert.equal(result.response, null);
    await assertReplay(f, task);
  });

  test(`${provider}: reusing a request with a different prompt conflicts before another send`, async t => {
    const f = await fixture(t, provider);
    f.adapter.attempt = async ({ beforeSubmit }) => {
      await beforeSubmit();
      throw new Error('connection lost after click');
    };
    const task = await f.kernel.send(f.input);
    const restarted = new TaskKernel([f.adapter], { directory: f.directory, verifyStoragePaths: async () => {} });
    for (const kernel of [f.kernel, restarted]) {
      await assert.rejects(kernel.send({ ...f.input, prompt: 'changed prompt' }), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
    }
    await assertReplay(f, task);
  });
}
