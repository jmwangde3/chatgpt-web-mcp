import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskKernel } from '../src/core/tasks.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'web-chat-progress-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let sends = 0;
  const page = {
    url: 'https://example.com/chat/1',
    userCount: 0,
    responseCount: 0,
    lastUser: '',
    busy: false,
    complete: false,
    text: '',
  };
  const adapter = {
    id: 'gemini',
    browser: { runExclusive: async fn => fn() },
    isRoot: () => false,
    prepare: async () => ({ ...page }),
    send: async ({ prompt }) => {
      sends += 1;
      page.userCount += 1;
      page.lastUser = prompt;
      page.busy = true;
      return { url: page.url };
    },
    inspect: async () => ({ ...page }),
    settle: async () => {},
    cancel: async () => { page.busy = false; },
  };
  const kernel = new TaskKernel([adapter], {
    directory,
    verifyStoragePaths: async () => {},
    progressStallMs: 120_000,
    controlBusyRetryMs: 10,
  });
  const task = await kernel.send({
    provider: 'gemini',
    request_id: 'progress-test',
    prompt: 'synthetic progress test prompt',
  });
  return { kernel, adapter, page, task, sends: () => sends };
}

test('progress distinguishes thinking, stalled, streaming and completed without changing task safety', async t => {
  const f = await fixture(t);

  // Simulate a v1/v2-era journal record with no progress metadata.
  await f.kernel.locked('gemini', async (state, save) => {
    delete state.tasks[f.task.task_id].progress;
    delete state.tasks[f.task.task_id].progressHash;
    await save();
  });

  const thinking = await f.kernel.read(f.task.task_id);
  assert.equal(thinking.state, 'running');
  assert.equal(thinking.progress.phase, 'thinking');
  assert.equal(thinking.progress.response_chars, 0);

  await f.kernel.locked('gemini', async (state, save) => {
    state.tasks[f.task.task_id].progress.last_progress_at = Date.now() - f.kernel.progressStallMs;
    await save();
  });
  const stalled = await f.kernel.read(f.task.task_id);
  assert.equal(stalled.state, 'running');
  assert.equal(stalled.progress.phase, 'stalled');
  assert.equal(stalled.error, null);

  f.page.responseCount = 1;
  f.page.text = 'partial answer';
  const streaming = await f.kernel.read(f.task.task_id);
  assert.equal(streaming.state, 'running');
  assert.equal(streaming.progress.phase, 'streaming');
  assert.equal(streaming.progress.response_chars, 'partial answer'.length);

  Object.assign(f.page, {
    busy: false,
    complete: true,
    responseCount: 1,
    text: 'complete answer',
  });
  const completed = await f.kernel.result(f.task.task_id);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.progress.phase, 'completed');
  assert.equal(completed.response.text, 'complete answer');
  assert.equal('progressHash' in completed, false);
  assert.equal(f.sends(), 1, 'progress observation must never resend');
});

test('result invokes the optional progress callback without changing the result contract', async t => {
  const f = await fixture(t);
  const updates = [];
  const result = await f.kernel.result(f.task.task_id, {
    onProgress: (progress, task) => updates.push({ phase: progress.phase, taskId: task.task_id }),
  });
  assert.equal(result.task_id, f.task.task_id);
  assert.equal(result.state, 'running');
  assert.deepEqual(updates, [{ phase: 'thinking', taskId: f.task.task_id }]);
  assert.equal(f.sends(), 1);
});


test('wait=true retries transient CONTROL_BUSY read-only and completes the same task', async t => {
  const f = await fixture(t);
  let observations = 0;
  f.adapter.inspect = async () => {
    observations += 1;
    if (observations === 1) throw Object.assign(new Error('controller cleanup'), { code: 'CONTROL_BUSY' });
    Object.assign(f.page, {
      busy: false,
      complete: true,
      responseCount: 1,
      text: 'complete after controller cleanup',
    });
    return { ...f.page };
  };

  const result = await f.kernel.result(f.task.task_id, { wait: true, timeoutMs: 1000 });
  assert.equal(result.state, 'completed');
  assert.equal(result.task_id, f.task.task_id);
  assert.equal(observations, 2);
  assert.equal(f.sends(), 1, 'read-only recovery must never resubmit');
});

test('CONTROL_BUSY retry is bounded by the original result deadline', async t => {
  const f = await fixture(t);
  f.kernel.controlBusyRetryMs = 5_000;
  let observations = 0;
  f.adapter.inspect = async () => {
    observations += 1;
    throw Object.assign(new Error('controller still busy'), { code: 'CONTROL_BUSY' });
  };

  const result = await f.kernel.result(f.task.task_id, { wait: true, timeoutMs: 1000 });
  assert.equal(result.state, 'uncertain');
  assert.equal(result.error.code, 'CONTROL_BUSY');
  assert.equal(result.timed_out, true);
  assert.equal(observations, 1, 'must not retry when the retry interval exceeds the caller budget');
  assert.equal(f.sends(), 1);
});

test('a retryable CONTROL_BUSY can resume in a later observation slice without resending', async t => {
  const f = await fixture(t);
  let observations = 0;
  f.kernel.controlBusyRetryMs = 5_000;
  f.adapter.inspect = async () => {
    observations += 1;
    throw Object.assign(new Error('controller remains busy'), { code: 'CONTROL_BUSY' });
  };

  const first = await f.kernel.result(f.task.task_id, { wait: true, timeoutMs: 1000 });
  assert.equal(first.state, 'uncertain');
  assert.equal(first.timed_out, true);
  assert.equal(first.error.retryable_observation, true);
  assert.equal(observations, 1);

  f.adapter.inspect = async () => {
    observations += 1;
    Object.assign(f.page, { busy: false, complete: true, responseCount: 1, text: 'completed in next slice' });
    return { ...f.page };
  };
  const second = await f.kernel.result(f.task.task_id, { wait: true, timeoutMs: 1000 });
  assert.equal(second.state, 'completed');
  assert.equal(second.task_id, first.task_id);
  assert.equal(second.response.text, 'completed in next slice');
  assert.equal(observations, 2);
  assert.equal(f.sends(), 1, 'later observation slices must never resubmit the prompt');
});

test('wait=true does not automatically retry other uncertain errors', async t => {
  const f = await fixture(t);
  let observations = 0;
  f.adapter.inspect = async () => {
    observations += 1;
    throw Object.assign(new Error('sign-in required'), { code: 'LOGIN_REQUIRED' });
  };

  const result = await f.kernel.result(f.task.task_id, { wait: true, timeoutMs: 1000 });
  assert.equal(result.state, 'uncertain');
  assert.equal(result.error.code, 'LOGIN_REQUIRED');
  assert.equal(result.timed_out, false);
  assert.equal(observations, 1);
  assert.equal(f.sends(), 1);
});

test('CONTROL_BUSY after the settlement boundary is not retried automatically', async t => {
  const f = await fixture(t);
  Object.assign(f.page, {
    busy: false,
    complete: true,
    responseCount: 1,
    text: 'completed answer before settle failure',
  });
  let observations = 0;
  let settlements = 0;
  f.adapter.inspect = async () => {
    observations += 1;
    return { ...f.page };
  };
  f.adapter.settle = async () => {
    settlements += 1;
    throw Object.assign(new Error('settle controller busy'), { code: 'CONTROL_BUSY' });
  };

  const result = await f.kernel.result(f.task.task_id, { wait: true, timeoutMs: 1000 });
  assert.equal(result.state, 'uncertain');
  assert.equal(result.error.code, 'CONTROL_BUSY');
  assert.equal(result.error.retryable_observation, undefined);
  assert.equal(result.recovery.action, 'inspect_page');
  assert.equal(observations, 1);
  assert.equal(settlements, 1);
  assert.equal(f.sends(), 1);
});
