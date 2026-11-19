import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskKernel, textHash } from '../src/core/tasks.js';

async function fixture(t, initial = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-abandon-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const page = {
    url: 'https://chatgpt.com',
    userCount: 0,
    responseCount: 0,
    lastUser: '',
    userMessageId: null,
    responseId: null,
    identitySnapshotValid: true,
    activeGeneration: null,
    generationOwnerExited: true,
    busy: false,
    text: '',
    ...initial,
  };
  const settled = [];
  const adapter = {
    id: 'chatgpt',
    messageIdentityVersion: 1,
    stagedSend: true,
    taskScope: 'chatgpt-dedicated',
    isRoot: url => url === 'https://chatgpt.com',
    isProvisional: () => false,
    browser: { runExclusive: operation => operation() },
    prepare: async () => ({
      url: page.url, userCount: page.userCount, responseCount: page.responseCount,
      userMessageId: page.userMessageId, responseId: page.responseId,
      baselineHash: textHash(page.lastUser),
    }),
    send: async ({ beforeSubmit }) => { await beforeSubmit(); return { url: page.url }; },
    inspect: async () => ({ ...page }),
    settle: async expected => { settled.push(expected); },
  };
  const kernel = new TaskKernel([adapter], { directory, verifyStoragePaths: async () => {} });
  const task = await kernel.send({ provider: 'chatgpt', request_id: 'baseline-test', prompt: 'must not be resent' });
  assert.equal(task.state, 'uncertain');
  assert.equal(task.error.code, 'SEND_UNCONFIRMED');
  return { kernel, page, task, settled };
}

test('explicit abandon releases only a completely unchanged empty baseline without a stable task message ID', async t => {
  const f = await fixture(t);
  const result = await f.kernel.abandon(f.task.task_id, { confirm: true });
  assert.equal(result.state, 'abandoned');
  assert.equal(f.settled.length, 1);
  assert.equal(f.settled[0].baselineOnly, true);
  assert.equal(f.settled[0].managedTaskId, f.task.task_id);
  assert.equal(f.settled[0].baselineUserMessageId, null);
  assert.equal(f.settled[0].baselineResponseId, null);
});

test('existing history baseline requires matching stable user and response IDs', async t => {
  const f = await fixture(t, {
    userCount: 1, responseCount: 1, lastUser: 'previous prompt',
    userMessageId: 'baseline-user', responseId: 'baseline-response',
  });
  const result = await f.kernel.abandon(f.task.task_id, { confirm: true });
  assert.equal(result.state, 'abandoned');
  assert.equal(f.settled[0].baselineUserMessageId, 'baseline-user');
  assert.equal(f.settled[0].baselineResponseId, 'baseline-response');
});

test('a changed baseline user or response ID keeps the legacy task reserved', async t => {
  for (const [field, replacement] of [['userMessageId', 'replacement-user'], ['responseId', 'replacement-response']]) {
    const f = await fixture(t, {
      userCount: 1, responseCount: 1, lastUser: 'previous prompt',
      userMessageId: 'baseline-user', responseId: 'baseline-response',
    });
    f.page[field] = replacement;
    const result = await f.kernel.abandon(f.task.task_id, { confirm: true });
    assert.equal(result.state, 'uncertain');
    assert.equal(result.error.code, 'LEGACY_IDENTITY_UNVERIFIED');
    assert.equal(f.settled.length, 0);
  }
});

test('a visible user turn without a persisted stable ID remains reserved', async t => {
  const f = await fixture(t);
  Object.assign(f.page, { userCount: 1, lastUser: 'must not be resent', identitySnapshotValid: true });
  const result = await f.kernel.abandon(f.task.task_id, { confirm: true });
  assert.equal(result.state, 'uncertain');
  assert.equal(f.settled.length, 0);
});

test('an active generation owned by another task is never cleared by baseline abandon', async t => {
  const f = await fixture(t);
  f.page.activeGeneration = { active: true, managedTaskId: 'chatgpt:00000000-0000-0000-0000-000000000000', url: f.page.url };
  f.page.generationOwnerExited = true;
  const result = await f.kernel.abandon(f.task.task_id, { confirm: true });
  assert.equal(result.state, 'uncertain');
  assert.equal(f.settled.length, 0);
});

test('same-task generation metadata is cleared only after owner exit and exact baseline verification', async t => {
  const f = await fixture(t);
  f.page.activeGeneration = { active: true, managedTaskId: f.task.task_id, url: f.page.url };
  f.page.generationOwnerExited = true;
  const result = await f.kernel.abandon(f.task.task_id, { confirm: true });
  assert.equal(result.state, 'abandoned');
  assert.equal(f.settled.length, 1);
  assert.equal(f.settled[0].managedTaskId, f.task.task_id);
});

test('same-task generation with a live/unknown owner remains reserved', async t => {
  const f = await fixture(t);
  f.page.activeGeneration = { active: true, managedTaskId: f.task.task_id, url: f.page.url };
  f.page.generationOwnerExited = false;
  const result = await f.kernel.abandon(f.task.task_id, { confirm: true });
  assert.equal(result.state, 'uncertain');
  assert.equal(f.settled.length, 0);
});
