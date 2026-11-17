import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskKernel, textHash } from '../src/core/tasks.js';

async function fixture(t, { callback = true, errorCode } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-task-id-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let sends = 0;
  const controls = [];
  const page = { url: 'https://chatgpt.com/c/conversation', userCount: 10, responseCount: 10,
    lastUser: 'previous prompt', userMessageId: 'previous-user', responseId: 'previous-answer',
    text: 'same answer', complete: true, busy: false, mountedUserCount: 10 };
  const adapter = { id: 'chatgpt', messageIdentityVersion: 1,
    isRoot: value => value === 'https://chatgpt.com', browser: { runExclusive: async fn => fn() },
    prepare: async () => ({ ...page, baselineHash: textHash(page.lastUser) }),
    inspect: async () => ({ ...page }),
    send: async ({ prompt, baseline, managedTaskId, onIdentityConfirmed }) => {
      sends++; assert.equal(baseline.userMessageId, 'previous-user'); assert.match(managedTaskId, /^chatgpt:/);
      Object.assign(page, { userCount: 11, mountedUserCount: 11, userMessageId: 'target-user', lastUser: prompt, busy: true, complete: false });
      if (callback) await onIdentityConfirmed({ userMessageId: page.userMessageId, lastUser: page.lastUser, url: page.url });
      if (errorCode) throw Object.assign(new Error('interrupted after click'), { code: errorCode });
      return { url: page.url };
    },
    settle: async identity => { controls.push(['settle', identity]); },
    cancel: async identity => { controls.push(['cancel', identity]); page.busy = false; },
  };
  const reconnect = () => new TaskKernel([adapter], { directory, verifyStoragePaths: async () => {} });
  return { kernel: reconnect(), reconnect, adapter, page, controls, sends: () => sends,
    input: { provider: 'chatgpt', request_id: 'request', prompt: 'full exact prompt' } };
}
const saved = async (f, task) => (await f.kernel.readSnapshot('chatgpt')).tasks[task.task_id];
const finish = f => Object.assign(f.page, { busy: false, complete: true, responseId: 'new-answer' });

test('interrupted preparation releases the session on read or abandon', async t => {
  for (const operation of ['read', 'abandon']) {
    const f = await fixture(t); const task = await f.kernel.send(f.input);
    await f.kernel.locked('chatgpt', async (state, save) => {
      const record = state.tasks[task.task_id];
      record.state = 'preparing'; record.blocking = true;
      delete record.targetUserMessageId; delete record.messageIdentityVersion;
      await save();
    });
    const result = operation === 'read' ? await f.reconnect().read(task.task_id)
      : await f.reconnect().abandon(task.task_id, { confirm: true });
    assert.equal(result.state, 'failed'); assert.equal(result.blocking, false);
    assert.equal(result.error.code, 'PREFLIGHT_INTERRUPTED');
  }
});

test('callback persists ID; reconnect completes identical answer text with new assistant ID', async t => {
  const f = await fixture(t); const task = await f.kernel.send(f.input);
  assert.equal(task.state, 'submitted'); assert.equal(task.messageIdentityVersion, 1);
  assert.equal(task.targetUserMessageId, undefined);
  assert.equal((await saved(f, task)).targetUserMessageId, 'target-user');
  finish(f); assert.equal((await f.reconnect().read(task.task_id)).state, 'completed');
  assert.deepEqual(f.controls[0][1], { url: f.page.url, userCount: 11, promptHash: textHash(f.input.prompt),
    userMessageId: 'target-user', targetUserMessageId: 'target-user', managedTaskId: task.task_id, messageIdentityVersion: 1 });
  assert.equal(f.sends(), 1);
});

test('physical user and assistant counts may shrink during virtualization', async t => {
  const f = await fixture(t); const task = await f.kernel.send(f.input);
  Object.assign(f.page, { userCount: 1, responseCount: 0, mountedUserCount: 1 });
  assert.equal((await f.kernel.read(task.task_id)).state, 'running');
  finish(f); assert.equal((await f.reconnect().read(task.task_id)).state, 'completed');
});

for (const [name, mutate] of [
  ['same prompt new user ID', p => { p.userMessageId = 'other-user'; }],
  ['same ID edited text', p => { p.lastUser += ' edited'; }],
  ['changed conversation', p => { p.url = 'https://chatgpt.com/c/other'; }],
]) test(`${name} cannot read, cancel or abandon`, async t => {
  for (const operation of ['read', 'cancel', 'abandon']) {
    const f = await fixture(t); const task = await f.kernel.send(f.input); mutate(f.page);
    const result = operation === 'abandon' ? await f.kernel.abandon(task.task_id, { confirm: true })
      : await f.kernel.read(task.task_id, { cancel: operation === 'cancel' });
    assert.equal(result.state, 'uncertain'); assert.equal(result.blocking, true);
    assert.equal(f.controls.length, 0); assert.equal((await saved(f, task)).targetUserMessageId, 'target-user');
  }
});

test('completion needs a new assistant ID regardless of physical response count', async t => {
  for (const responseId of [null, '', 'previous-answer']) {
    const f = await fixture(t); const task = await f.kernel.send(f.input);
    Object.assign(f.page, { complete: true, busy: false, responseCount: 100, responseId });
    assert.equal((await f.kernel.read(task.task_id)).state, 'submitted'); assert.equal(f.controls.length, 0);
    finish(f); assert.equal((await f.kernel.read(task.task_id)).state, 'completed');
  }
});

test('missing callback ID stays uncertain and cannot be adopted from inspect', async t => {
  for (const errorCode of [undefined, 'SEND_UNCONFIRMED']) {
    const f = await fixture(t, { callback: false, errorCode }); const task = await f.kernel.send(f.input);
    assert.equal(task.state, 'uncertain'); finish(f);
    assert.equal((await f.kernel.read(task.task_id)).state, 'uncertain');
    assert.equal((await saved(f, task)).targetUserMessageId, undefined); assert.equal(f.controls.length, 0);
    assert.equal(f.sends(), 1);
  }
});

test('callback then interruption recovers without resending, including count shrink', async t => {
  for (const errorCode of ['INTERRUPTED', 'SEND_UNCONFIRMED']) {
    const f = await fixture(t, { errorCode }); const send = f.adapter.send;
    f.adapter.send = async options => { try { return await send(options); } finally { f.page.userCount = 1; } };
    const task = await f.kernel.send(f.input);
    assert.equal(task.state, errorCode === 'SEND_UNCONFIRMED' ? 'submitted' : 'uncertain');
    assert.equal((await f.reconnect().send(f.input)).replayed, true);
    finish(f); assert.equal((await f.reconnect().read(task.task_id)).state, 'completed'); assert.equal(f.sends(), 1);
  }
});

test('same callback ID is idempotent; switching ID or using baseline ID is rejected', async t => {
  for (const nextId of ['target-user', 'other-user', 'previous-user']) {
    const f = await fixture(t); const send = f.adapter.send;
    f.adapter.send = async options => {
      const result = await send(options);
      assert.equal((await f.kernel.readSnapshot('chatgpt')).tasks[options.managedTaskId].targetUserMessageId, 'target-user');
      await options.onIdentityConfirmed({ ...f.page, userMessageId: nextId }); return result;
    };
    const task = await f.kernel.send(f.input);
    assert.equal(task.state, nextId === 'target-user' ? 'submitted' : 'uncertain');
    assert.equal((await saved(f, task)).targetUserMessageId, 'target-user');
  }
});

test('normal send acknowledgement must match callback ID and full prompt', async t => {
  for (const mutate of [p => { p.userMessageId = 'other'; }, p => { p.lastUser += ' edited'; }]) {
    const f = await fixture(t); const send = f.adapter.send;
    f.adapter.send = async options => { const result = await send(options); mutate(f.page); return result; };
    const task = await f.kernel.send(f.input); assert.equal(task.state, 'uncertain');
    assert.equal((await saved(f, task)).targetUserMessageId, 'target-user');
  }
});

test('legacy nonterminal remains blocked without adopting current ID', async t => {
  for (const operation of ['read', 'refresh', 'cancel', 'abandon']) {
    const f = await fixture(t); const task = await f.kernel.send(f.input);
    await f.kernel.locked('chatgpt', async (state, save) => {
      delete state.tasks[task.task_id].messageIdentityVersion; delete state.tasks[task.task_id].targetUserMessageId; await save();
    });
    f.adapter.inspect = () => assert.fail('do not adopt the current ID');
    const result = operation === 'abandon' ? await f.kernel.abandon(task.task_id, { confirm: true })
      : await f.kernel.read(task.task_id, { cancel: operation === 'cancel', refresh: operation === 'refresh' });
    assert.equal(result.state, 'uncertain'); assert.equal(result.error.code, 'LEGACY_IDENTITY_UNVERIFIED');
    assert.equal(result.blocking, true); assert.equal(f.controls.length, 0);
  }
});

test('legacy completed cache remains unchanged even on refresh', async t => {
  const f = await fixture(t); const task = await f.kernel.send(f.input); finish(f); await f.kernel.read(task.task_id);
  await f.kernel.locked('chatgpt', async (state, save) => {
    delete state.tasks[task.task_id].messageIdentityVersion; delete state.tasks[task.task_id].targetUserMessageId; await save();
  });
  const before = await saved(f, task); f.adapter.inspect = () => assert.fail('preserve cache');
  assert.equal((await f.kernel.read(task.task_id, { refresh: true })).state, 'completed');
  assert.deepEqual(await saved(f, task), before);
});

test('cancel and abandon use stable ID despite physical count changes', async t => {
  for (const operation of ['cancel', 'abandon']) {
    const f = await fixture(t); const task = await f.kernel.send(f.input); f.page.userCount = 1;
    if (operation === 'abandon') f.page.busy = false;
    const result = operation === 'abandon' ? await f.kernel.abandon(task.task_id, { confirm: true })
      : await f.kernel.read(task.task_id, { cancel: true });
    assert.equal(result.state, operation === 'abandon' ? 'abandoned' : 'cancelled');
    for (const [, identity] of f.controls) {
      assert.equal(identity.userCount, 1); assert.equal(identity.userMessageId, 'target-user');
      assert.equal(identity.targetUserMessageId, 'target-user'); assert.equal(identity.messageIdentityVersion, 1);
    }
  }
});
