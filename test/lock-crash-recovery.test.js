import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireLock, lockOwnerState } from '../src/shared/locks.js';

const moduleUrl = new URL('../src/shared/locks.js', import.meta.url).href;
const childSource = `
import { acquireLock } from ${JSON.stringify(moduleUrl)};
const config = JSON.parse(process.argv[1]);
const commands = new Map();
let paused = false;
process.on('message', message => commands.get(message)?.());
const wait = command => new Promise(resolve => commands.set(command, resolve));
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
try {
  if (config.gated) { const go = wait('go'); await send({ event: 'ready' }); await go; }
  const release = await acquireLock(config.file, {
    timeout: config.timeout ?? 15000, heartbeatMs: 60000,
    onPhase: async (phase, file) => {
      if (phase === 'prepared' && file === config.file) await send({ event: 'attempting' });
      if (!paused && phase === config.phase && file === config.target) {
        paused = true;
        const resume = wait('resume');
        await send({ event: 'phase', phase, file });
        await resume;
      }
    }
  });
  const done = wait('release');
  await send({ event: 'acquired' });
  await done;
  await release();
  await send({ event: 'released' });
  process.disconnect();
} catch (error) {
  await send({ event: 'error', code: error.code, message: error.stack });
  process.exitCode = 1;
  process.disconnect();
}
`;

async function fixture(t) {
  const base = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp') : os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'lock-crash-'));
  const children = [];
  const releases = [];
  t.after(async () => {
    try {
      await Promise.all(children.map(child => child.kill()));
      for (const release of releases.reverse()) await release();
    } finally {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  });
  const file = path.join(directory, 'operation.lock');
  function start(options = {}) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource,
      JSON.stringify({ file, ...options })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    const messages = [];
    let stderr = '', spawnError;
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.on('message', message => messages.push(message));
    child.on('error', error => { spawnError = error; });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    let ended = false;
    closed.then(() => { ended = true; });
    const api = {
      child, messages,
      send: command => new Promise((resolve, reject) => child.send(command, error => error ? reject(error) : resolve())),
      async event(event) {
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          const failure = messages.find(message => message.event === 'error');
          assert.equal(failure, undefined, failure?.message);
          const message = messages.find(message => message.event === event);
          if (message) return message;
          assert.equal(ended, false, `child exited before ${event}: ${stderr}`);
          if (spawnError) throw spawnError;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail(`child timed out waiting for ${event}: ${stderr}`);
      },
      async kill() {
        if (!ended && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        return closed;
      },
      async finish() {
        await api.send('release');
        await api.event('released');
        assert.deepEqual(await closed, { code: 0, signal: null });
      }
    };
    children.push(api);
    return api;
  }
  return { file, directory, start, hold: async () => {
    const release = await acquireLock(file, { timeout: 10000 });
    releases.push(release);
    return release;
  } };
}

const owner = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const absent = file => assert.rejects(fs.stat(file), { code: 'ENOENT' });
async function killAt(child) {
  await child.event('phase');
  const result = await child.kill();
  assert.ok(result.signal === 'SIGKILL' || (process.platform === 'win32' && result.code !== 0),
    `expected forced termination: ${JSON.stringify(result)}`);
}
async function seedDeadOwner(f) {
  const child = f.start({ phase: 'published', target: f.file });
  await child.event('phase');
  const dead = await owner(f.file);
  assert.equal(dead.pid, child.child.pid);
  await killAt(child);
  assert.equal(await lockOwnerState(dead), 'DEAD');
  await fs.writeFile(f.file, JSON.stringify(dead), 'utf8');
  return dead;
}

test('crash at prepared never publishes an empty canonical lock; a fresh process acquires', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const child = f.start({ phase: 'prepared', target: f.file });
  await child.event('phase');
  await absent(f.file);
  const temps = (await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp'));
  assert.equal(temps.length, 1);
  assert.equal((await owner(path.join(f.directory, temps[0]))).pid, child.child.pid);
  await killAt(child);
  await absent(f.file);
  const successor = f.start();
  await successor.event('acquired');
  assert.equal((await owner(f.file)).pid, successor.child.pid);
  await successor.finish();
  await absent(f.file);
});

for (const phase of ['published', 'releasing']) {
  test(`crash at ${phase} leaves a complete dead owner that can be reclaimed`, { timeout: 60000 }, async t => {
    const f = await fixture(t);
    const child = f.start({ phase, target: f.file });
    if (phase === 'releasing') { await child.event('acquired'); await child.send('release'); }
    await child.event('phase');
    const before = await owner(f.file);
    assert.equal(before.pid, child.child.pid);
    assert.equal(await lockOwnerState(before), 'ALIVE');
    await killAt(child);
    assert.deepEqual(await owner(f.file), before);
    assert.equal(await lockOwnerState(before), 'DEAD');
    const release = await f.hold();
    assert.notEqual((await owner(f.file)).token, before.token);
    await release();
    await absent(f.file);
    await absent(f.file + '.reclaim');
  });
}

test('killed published reclaimers recover recursively through .reclaim.reclaim', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const dead = await seedDeadOwner(f);
  for (const suffix of ['.reclaim', '.reclaim.reclaim']) {
    const target = f.file + suffix;
    const child = f.start({ phase: 'published', target });
    await child.event('phase');
    const reclaimer = await owner(target);
    assert.equal(reclaimer.pid, child.child.pid);
    assert.equal(await lockOwnerState(reclaimer), 'ALIVE');
    assert.deepEqual(await owner(f.file), dead);
    await killAt(child);
    assert.equal(await lockOwnerState(await owner(target)), 'DEAD');
  }
  const successor = f.start();
  await successor.event('acquired');
  assert.equal((await owner(f.file)).pid, successor.child.pid);
  for (const suffix of ['.reclaim', '.reclaim.reclaim', '.reclaim.reclaim.reclaim']) await absent(f.file + suffix);
  await successor.finish();
  await absent(f.file);
});

test('two real reclaimers cannot steal a live reclaim mutex or hold the main lock together', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const dead = await seedDeadOwner(f);
  const first = f.start({ phase: 'published', target: f.file + '.reclaim' });
  await first.event('phase');
  const mutex = await owner(f.file + '.reclaim');
  assert.equal(mutex.pid, first.child.pid);
  const second = f.start({ gated: true });
  await second.event('ready');
  await second.send('go');
  await second.event('attempting');
  // Allow repeated real acquisition attempts while the first process is paused.
  await assert.rejects(acquireLock(f.file, { timeout: 800 }), { code: 'BUSY' });
  assert.equal(await lockOwnerState(mutex), 'ALIVE');
  assert.deepEqual(await owner(f.file + '.reclaim'), mutex);
  assert.deepEqual(await owner(f.file), dead);
  assert.equal(second.messages.some(message => message.event === 'acquired'), false);
  await first.send('resume');
  // Either contender may win after the reclaim mutex is released.
  await Promise.race([first.event('acquired'), second.event('acquired')]);
  const current = await owner(f.file);
  const winner = current.pid === first.child.pid ? first : second;
  const loser = winner === first ? second : first;
  assert.ok([first.child.pid, second.child.pid].includes(current.pid));
  await assert.rejects(acquireLock(f.file, { timeout: 500 }), { code: 'BUSY' });
  assert.deepEqual(await owner(f.file), current);
  assert.equal(loser.messages.some(message => message.event === 'acquired'), false);
  await winner.finish();
  await loser.event('acquired');
  assert.equal((await owner(f.file)).pid, loser.child.pid);
  await loser.finish();
  await absent(f.file);
  await absent(f.file + '.reclaim');
});
