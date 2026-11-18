import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BROWSER_STATE_FILE, CHROME_EXECUTABLE, USER_DATA_DIR } from '../src/config.js';
import { geminiConfig } from '../src/gemini/config.js';
import { PersistentBrowser, writeState, readState } from '../src/shared/persistent-browser.js';
import { TaskKernel } from '../src/core/tasks.js';
import { createHash } from 'node:crypto';

test('shared mode reuses only the ChatGPT browser identity', () => {
  const env = { GEMINI_WEB_DATA_DIR: path.resolve('gemini-fixture') };
  const independent = geminiConfig(env);
  const shared = geminiConfig({ ...env, WEB_CHAT_SHARED_BROWSER: 'true' });
  assert.notEqual(independent.profile, shared.profile);
  assert.equal(shared.profile, USER_DATA_DIR);
  assert.equal(shared.browserState, BROWSER_STATE_FILE);
  assert.equal(shared.executable, CHROME_EXECUTABLE);
  assert.equal(shared.browserLaunchLock, `${BROWSER_STATE_FILE}.launch.lock`);
  assert.notEqual(shared.runtimeState, independent.runtimeState);
  assert.match(shared.taskScope, /^gemini-shared-[a-f0-9]{64}$/);
  for (const field of ['url', 'operationLock', 'taskLock', 'archiveDir']) {
    assert.equal(shared[field], independent[field]);
  }
});

test('changing Gemini browser mode blocks old browser operations but preserves request replay', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-browser-tasks-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const file = path.join(directory, 'gemini', 'tasks.json');
  const task = { task_id: 'gemini:00000000-0000-4000-8000-000000000001', provider: 'gemini',
    state: 'submitted', blocking: true, requestHash: hash('old'), fingerprint: hash({ prompt: 'same prompt', files: [] }) };
  const state = { version: 1, active: task.task_id, tasks: { [task.task_id]: task } };
  await writeState(file, state);
  const kernel = new TaskKernel([{ id: 'gemini', taskScope: 'shared-profile',
    browser: { runExclusive: () => assert.fail('must not touch any page') } }],
  { directory, verifyStoragePaths: async () => {} });
  for (const operation of [
    () => kernel.read(task.task_id),
    () => kernel.read(task.task_id, { cancel: true }),
    () => kernel.abandon(task.task_id, { confirm: true }),
    () => kernel.retry(task.task_id),
  ]) await assert.rejects(operation(), { code: 'TASK_BROWSER_SCOPE_CHANGED' });
  const replay = await kernel.send({ provider: 'gemini', request_id: 'old', prompt: 'same prompt' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.task_id, task.task_id);
  assert.deepEqual(await readState(file), state);
});

test('providers serialize browser startup through the same cross-process lock', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-browser-lock-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const browserState = path.join(directory, 'browser-state.json');
  const config = { browserState, browserLaunchLock: `${browserState}.launch.lock`, actionTimeout: 5_000 };
  const first = new PersistentBrowser(config, { security: null });
  const second = new PersistentBrowser(config, { security: null });
  let entered;
  let releaseFirst;
  const firstEntered = new Promise(resolve => { entered = resolve; });
  const waitForRelease = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  first.connectOnce = async () => {
    calls.push('first');
    entered();
    await waitForRelease;
    calls.push('first finished');
  };
  second.connectOnce = async () => { calls.push('second'); };
  const firstCall = first.connect();
  await firstEntered;
  const secondCall = second.connect();
  releaseFirst();
  await Promise.all([firstCall, secondCall]);
  assert.deepEqual(calls, ['first', 'first finished', 'second']);
});

test('provider-level termination is disabled in shared mode', async () => {
  const runtime = new PersistentBrowser({ browserState: 'unused-browser-state', preventTerminate: true });
  await assert.rejects(runtime.terminate(), { code: 'SHARED_BROWSER' });
});
