import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Node's test runner gives this file its own process. Configure every persistent
// path before importing production modules; no user profile or browser is used.
const directory = await fs.mkdtemp(new URL('../.generation-recovery-', import.meta.url));
for (const [key, name] of Object.entries({
  RUNTIME_STATE: 'runtime.json', BROWSER_STATE: 'browser.json', PROFILE: 'profile',
  OPERATION_LOCK: 'operation.lock', NETWORK_LOG: 'network.jsonl', CONTEXT_ARCHIVE_DIR: 'archive',
})) process.env[`CHATGPT_WEB_${key}`] = path.join(directory, name);
process.env.CHATGPT_WEB_ACTION_TIMEOUT_MS = '200';
after(() => fs.rm(directory, { recursive: true, force: true }));

const { ChatGPTBrowser, withRuntimeState, generationCompletionEvidence } = await import('../src/browser.js');
const { RUNTIME_STATE_FILE, RUNTIME_LOCK_FILE } = await import('../src/config.js');
const { acquireLock } = await import('../src/shared/locks.js');
const { ownProcessIdentity } = await import('../src/shared/process-identity.js');
// Populate the real self-identity cache before short lock deadlines start.
await ownProcessIdentity();
const exited = spawn(process.execPath, ['-e', ''], { windowsHide: true });
await once(exited, 'exit');
const deadPid = exited.pid;
assert.throws(() => process.kill(deadPid, 0));
const url = 'https://chatgpt.com/c/recovery-unit';
const generation = () => ({ active: true, ownerPid: deadPid, url, assistantBefore: 1, baselineResponse: 'baseline' });
const read = async () => JSON.parse(await fs.readFile(RUNTIME_STATE_FILE, 'utf8'));
const seed = async () => {
  const state = { activeGeneration: generation(), sentinel: 'preserve' };
  await fs.writeFile(RUNTIME_STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return state;
};
const bytes = () => fs.readFile(RUNTIME_STATE_FILE);

// These public-method stubs model observations only, never a Chromium session.
function browser({ pageURL = url, text = 'changed complete reply', stop = false, streaming = false, failure } = {}) {
  const instance = new ChatGPTBrowser();
  instance.page = async () => {
    if (failure) throw failure;
    return { url: () => pageURL, locator: () => ({ innerText: async () => '' }) };
  };
  instance.assistantLocator = () => ({ count: async () => 1, last: () => ({ innerText: async () => text }) });
  instance.userLocator = () => ({ count: async () => 0 });
  instance.firstVisible = async () => stop ? { visible: true } : null;
  instance.assistantIsStreaming = async () => streaming;
  instance.currentMode = async () => 'normal';
  instance.temporaryState = async () => false;
  return instance;
}
const latest = instance => instance.getLatestResponse({ includeTranscript: false });
const denied = instance => assert.rejects(instance.assertActionsAllowed('unit-send'), error => Boolean(error.details?.activeGeneration?.active));

test('dead owner plus visible Stop preserves generation and rejects actions', async () => {
  const state = await seed();
  const before = await bytes();
  const instance = browser({ stop: true });
  const result = await latest(instance);
  assert.equal(result.generating, true);
  assert.equal(result.generationOwnerExited, true);
  assert.deepEqual(result.activeGeneration, state.activeGeneration);
  await denied(instance);
  assert.deepEqual(await bytes(), before);
});

test('dead owner plus same URL and complete changed reply clears generation', async () => {
  await seed();
  const instance = browser();
  const result = await latest(instance);
  assert.equal(result.generating, false);
  assert.equal(result.generationOwnerExited, true);
  assert.equal(result.activeGeneration, null);
  const state = await read();
  assert.equal(state.activeGeneration, null);
  assert.equal(state.sentinel, 'preserve');
  assert.ok(state.lastGenerationCompletedAt > 0);
  assert.deepEqual(await instance.assertActionsAllowed(), { allowed: true });
});

test('wrong URL rejects and preserves exact runtime bytes', async () => {
  await seed();
  const before = await bytes();
  await assert.rejects(latest(browser({ pageURL: 'https://chatgpt.com/c/wrong' })), { code: 'GENERATION_CONVERSATION_MISMATCH' });
  assert.deepEqual(await bytes(), before);
});

for (const [name, text] of [['empty', '  \n '], ['unchanged baseline', ' baseline ']]) {
  test(`${name} reply cannot clear generation`, async () => {
    await seed();
    const before = await bytes();
    const instance = browser({ text });
    assert.equal(generationCompletionEvidence(await read(), { url, generating: false, responseCount: 1, responseText: text }), false);
    assert.deepEqual((await latest(instance)).activeGeneration, generation());
    await denied(instance);
    assert.deepEqual(await bytes(), before);
  });
}

test('streaming without Stop still cannot clear generation', async () => {
  await seed();
  const before = await bytes();
  const instance = browser({ streaming: true });
  assert.equal((await latest(instance)).generating, true);
  await denied(instance);
  assert.deepEqual(await bytes(), before);
});

for (const code of ['PAGE_UNAVAILABLE', 'CONTROL_CONNECT_TIMEOUT']) {
  test(`page/CDP failure ${code} preserves generation and exact bytes`, async () => {
    await seed();
    const before = await bytes();
    const failure = Object.assign(new Error('controlled page/connection failure'), { code });
    const instance = browser({ failure });
    await assert.rejects(latest(instance), error => error === failure);
    await denied(instance);
    assert.deepEqual(await bytes(), before);
  });
}

test('real live runtime lock cannot be removed because its mtime is old', async () => {
  await seed();
  const before = await bytes();
  const release = await acquireLock(RUNTIME_LOCK_FILE, { heartbeatMs: 60000 });
  try {
    const owner = await fs.readFile(RUNTIME_LOCK_FILE);
    const old = new Date(Date.now() - 120000);
    await fs.utimes(RUNTIME_LOCK_FILE, old, old);
    let called = false;
    await assert.rejects(withRuntimeState(async state => { called = true; return { state }; }), { code: 'BUSY' });
    assert.equal(called, false);
    assert.deepEqual(await fs.readFile(RUNTIME_LOCK_FILE), owner);
    assert.deepEqual(await bytes(), before);
  } finally { await release(); }
});

test('throwing update releases runtime lock without writing state', async () => {
  await seed();
  const before = await bytes();
  const failure = new Error('callback sentinel');
  await assert.rejects(withRuntimeState(async () => { throw failure; }), error => error === failure);
  assert.deepEqual(await bytes(), before);
  await assert.rejects(fs.stat(RUNTIME_LOCK_FILE), { code: 'ENOENT' });
  assert.equal(await withRuntimeState(async state => ({ state: { ...state, recovered: true }, result: 'released' })), 'released');
  assert.deepEqual((await read()).activeGeneration, generation());
});

test('repairing a dead update-lock owner does not clear activeGeneration', async () => {
  await seed();
  await fs.writeFile(RUNTIME_LOCK_FILE, JSON.stringify({ pid: deadPid, token: 'dead-update-owner', processStartIdentity: 'dead', startedAt: 1, operation: 'runtime-state' }), 'utf8');
  await withRuntimeState(async state => ({ state: { ...state, repaired: true } }));
  assert.deepEqual((await read()).activeGeneration, generation());
  assert.equal((await read()).repaired, true);
  await assert.rejects(fs.stat(RUNTIME_LOCK_FILE), { code: 'ENOENT' });
  await denied(browser());
});

test('two real Node processes concurrently update different sessions without lost fields', { timeout: 20000 }, async t => {
  await seed();
  const moduleURL = new URL('../src/browser.js', import.meta.url).href;
  const worker = `
    import { setTimeout as delay } from 'node:timers/promises';
    const { withRuntimeState } = await import(${JSON.stringify(moduleURL)});
    const { ownProcessIdentity } = await import(${JSON.stringify(new URL('../src/shared/process-identity.js', import.meta.url).href)});
    await ownProcessIdentity();
    // Install the command listener before advertising readiness.
    const go = new Promise((resolve, reject) => process.once('message', message => {
      if (message === 'go') resolve();
      else reject(new Error('Unexpected worker command'));
    }));
    await new Promise((resolve, reject) => process.send('ready', error => error ? reject(error) : resolve()));
    await go;
    await withRuntimeState(async state => {
      await delay(100);
      const id = process.env.RECOVERY_SESSION;
      return { state: { ...state, sessions: { ...state.sessions,
        [id]: { ...state.sessions?.[id], sessionInitialized: true, marker: id } } } };
    });
    process.disconnect();
  `;
  const children = ['session-a', 'session-b'].map(id => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker], {
      env: { ...process.env, CHATGPT_WEB_ACTION_TIMEOUT_MS: '5000', RECOVERY_SESSION: id },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr += data; });
    // Keep one exit observation for both normal completion and cleanup. Never
    // register an exit listener after kill(), which can miss a fast exit.
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const done = exit.then(({ code, signal }) => assert.equal(code, 0, `${id}: ${signal || ''} ${stderr}`));
    const ready = new Promise((resolve, reject) => {
      // 'message' also supplies an optional sendHandle (usually undefined).
      // Validate the payload, not events.once()'s entire argument array.
      const onMessage = message => {
        child.removeListener('message', onMessage);
        if (message === 'ready') resolve();
        else reject(new Error(`${id}: unexpected readiness payload ${JSON.stringify(message)}`));
      };
      child.on('message', onMessage);
      exit.then(({ code, signal }) => {
        child.removeListener('message', onMessage);
        reject(new Error(`${id}: exited before readiness: ${code} ${signal || ''} ${stderr}`));
      }, reject);
    });
    // Handle rejections immediately while the other worker is starting.
    done.catch(() => {});
    ready.catch(() => {});
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exit.catch(() => {});
    });
    return { child, ready, done };
  });
  await Promise.all(children.map(({ ready }) => ready));
  await Promise.all(children.map(({ child }) => new Promise((resolve, reject) => {
    child.send('go', error => error ? reject(error) : resolve());
  })));
  await Promise.all(children.map(({ done }) => done));
  const state = await read();
  for (const id of ['session-a', 'session-b']) assert.deepEqual(state.sessions[id], { sessionInitialized: true, marker: id });
  assert.deepEqual(state.activeGeneration, generation());
  assert.equal(state.sentinel, 'preserve');
  await assert.rejects(fs.stat(RUNTIME_LOCK_FILE), { code: 'ENOENT' });
});
