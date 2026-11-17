import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskKernel, textHash } from '../src/core/tasks.js';
import { readState, writeState } from '../src/shared/persistent-browser.js';
import { ChatGPTBrowser } from '../src/browser.js';
import { chatgptProvider, geminiProvider } from '../src/providers/adapters.js';

async function fixture(t, id = 'chatgpt') {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), ...(process.env.LOCALAPPDATA ? ['Temp'] : []));
  const directory = await fs.mkdtemp(path.join(root, 'task-identity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const page = { url: `https://${id}.example/c/original`, userCount: 1, responseCount: 1, lastUser: 'old user', busy: false };
  const calls = [];
  const adapter = { id, isRoot: () => false, stagedSend: true,
    browser: { runExclusive: fn => fn() },
    prepare: async () => ({ ...page }),
    send: async ({ prompt, beforeSubmit }) => { await beforeSubmit(); page.userCount++; page.lastUser = prompt; page.busy = true; return { url: page.url }; },
    inspect: async () => ({ ...page }),
    cancel: async expected => { calls.push(['cancel', expected]); page.busy = false; },
    settle: async (...args) => { calls.push(['settle', ...args]); },
  };
  const kernel = new TaskKernel([adapter], { directory });
  const task = await kernel.send({ provider: id, request_id: 'identity', prompt: 'original prompt' });
  return { page, adapter, calls, kernel, task, file: path.join(directory, id, 'tasks.json') };
}

for (const change of ['url', 'count', 'hash', 'baselineResponse', 'none']) {
  test(`ChatGPT settle revalidates before any completion-reading mutation: ${change}`, async () => {
    const browser = new ChatGPTBrowser();
    const expected = { url: 'https://chatgpt.com/c/original', userCount: 1, promptHash: textHash('original') };
    const identity = { url: expected.url, count: 1, isLast: true, lastText: 'original', identityCandidates: [], responseCount: 1 };
    let reads = 0;
    browser.page = async () => ({ evaluate: async () => identity });
    browser.getLatestResponse = async () => { reads++; return { url: expected.url, userMessageCount: 1, lastUserMessage: 'original', assistantMessageCount: 1, generating: false }; };
    if (change === 'url') identity.url += '-manual';
    if (change === 'count') identity.count++;
    if (change === 'hash') identity.lastText = 'edited';
    if (change === 'baselineResponse') Object.assign(expected, { baselineOnly: true, baselineHash: textHash('original'), responseCount: 0 });
    if (change === 'none') { await browser.settleManagedGeneration(expected); assert.equal(reads, 1); }
    else { await assert.rejects(browser.settleManagedGeneration(expected)); assert.equal(reads, 0); }
  });
}

test('real provider adapters prepare baseline hash and forward expected to settle', async () => {
  const calls = [];
  const browser = {
    editable: async () => {}, snapshot: async () => ({ url: 'https://gemini.google.com/app/test', userCount: 1, responseCount: 2, lastUser: 'baseline' }),
    assertActionsAllowed: async () => {}, ensureSignedIn: async () => {}, assertComposerEmpty: async () => {}, ensureConversationCapacity: async () => {}, refreshBeforeSend: async () => {},
    applySendSettings: async () => ({}), getLatestResponse: async () => ({ url: 'https://chatgpt.com/c/test', userMessageCount: 1, assistantMessageCount: 2, lastUserMessage: 'baseline' }),
    settlePending: async (...args) => calls.push(['gemini', ...args]), settleManagedGeneration: async (...args) => calls.push(['chatgpt', ...args]),
  };
  const expected = { url: 'original', userCount: 2, promptHash: textHash('sent') };
  for (const provider of [geminiProvider(browser), chatgptProvider(browser)]) {
    assert.equal((await provider.prepare()).baselineHash, textHash('baseline'));
    await provider.settle(expected, { allowIdle: true });
  }
  assert.deepEqual(calls, [['gemini', expected, { allowIdle: true }], ['chatgpt', expected, { allowIdle: true }]]);
});

for (const id of ['chatgpt', 'gemini']) {
  test(`${id}: cancellation and settle receive exact current count and original hash`, async t => {
    const f = await fixture(t, id);
    assert.equal((await f.kernel.read(f.task.task_id, { cancel: true })).state, 'cancelled');
    const expected = { url: f.page.url, userCount: 2, promptHash: textHash('original prompt') };
    assert.deepEqual(f.calls, [['cancel', expected], ['settle', expected, { allowIdle: true }]]);
  });
  test(`${id}: completion passes identity to settle`, async t => {
    const f = await fixture(t, id);
    Object.assign(f.page, { busy: false, complete: true, responseCount: 2, text: 'answer' });
    assert.equal((await f.kernel.read(f.task.task_id)).state, 'completed');
    assert.deepEqual(f.calls[0], ['settle', { url: f.page.url, userCount: 2, promptHash: textHash('original prompt') }]);
  });
  for (const change of ['url', 'count', 'hash', 'transport', 'settle']) {
    test(`${id}: ${change} cancellation failure preserves uncertain reservation`, async t => {
      const f = await fixture(t, id);
      if (change === 'url') f.page.url += '-other';
      if (change === 'count') f.page.userCount++;
      if (change === 'hash') f.page.lastUser = 'manual replacement';
      if (change === 'transport') f.adapter.cancel = async () => { throw new Error('lost click transport'); };
      if (change === 'settle') f.adapter.settle = async () => { throw new Error('identity changed after click'); };
      const result = await f.kernel.read(f.task.task_id, { cancel: true });
      assert.equal(result.state, 'uncertain'); assert.equal(result.blocking, true);
      assert.equal((await readState(f.file)).active, f.task.task_id);
      if (['url', 'count', 'hash'].includes(change)) assert.equal(f.calls.length, 0);
    });
  }
  test(`${id}: verified sent abandonment passes original identity`, async t => {
    const f = await fixture(t, id); f.page.busy = false;
    assert.equal((await f.kernel.abandon(f.task.task_id, { confirm: true })).state, 'abandoned');
    assert.equal(f.calls[0][1].promptHash, textHash('original prompt'));
    assert.equal(f.calls[0][1].baselineOnly, undefined);
  });
  for (const change of ['none', 'lastUser', 'responseCount', 'missingHash']) {
    test(`${id}: baseline abandonment ${change}`, async t => {
      const f = await fixture(t, id);
      Object.assign(f.page, { busy: false, userCount: 1, lastUser: 'old user' });
      if (change === 'lastUser') f.page.lastUser = 'replaced old user';
      if (change === 'responseCount') f.page.responseCount++;
      if (change === 'missingHash') {
        const state = await readState(f.file); delete state.tasks[f.task.task_id].baseline.baselineHash; await writeState(f.file, state);
      }
      if (change === 'none') {
        assert.equal((await f.kernel.abandon(f.task.task_id, { confirm: true })).state, 'abandoned');
        assert.deepEqual(f.calls[0][1], { url: f.page.url, userCount: 1, promptHash: textHash('original prompt'), baselineOnly: true, baselineHash: textHash('old user'), responseCount: 1 });
      } else {
        const before = await fs.readFile(f.file);
        await assert.rejects(f.kernel.abandon(f.task.task_id, { confirm: true }), { code: 'TASK_IDENTITY_CHANGED' });
        assert.deepEqual(await fs.readFile(f.file), before); assert.equal(f.calls.length, 0);
      }
    });
  }
}
