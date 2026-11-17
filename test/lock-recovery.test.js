import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, readLockSnapshot, lockOwnerState } from '../src/shared/locks.js';
import { acquireLock as browserAcquireLock } from '../src/shared/persistent-browser.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-recovery-'));
  const releases = [];
  t.after(async () => {
    try { for (const release of releases.reverse()) await release(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  const file = path.join(directory, 'operation.lock');
  return { file, hold: async options => {
    const release = await acquireLock(file, options);
    releases.push(release);
    return release;
  } };
}
const readOwner = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const oldOwner = (extra = {}) => ({ pid: process.pid, token: 'old-token', operation: 'old', startedAt: 1, processStartIdentity: 'old-identity', ...extra });
const writeOwner = (file, owner) => fs.writeFile(file, JSON.stringify(owner), 'utf8');
const busy = promise => assert.rejects(promise, error => error.code === 'BUSY');

test('creation writes identity metadata, reexport matches, and normal release removes lock', async t => {
  const { file, hold } = await fixture(t);
  assert.equal(browserAcquireLock, acquireLock);
  const before = Date.now();
  const release = await hold({ operation: 'recovery_test' });
  const owner = await readOwner(file);
  assert.equal(owner.pid, process.pid);
  assert.match(owner.token, /^[0-9a-f-]{36}$/i);
  assert.equal(owner.operation, 'recovery_test');
  assert.ok(owner.startedAt >= before && owner.startedAt <= Date.now());
  assert.equal(typeof owner.processStartIdentity, 'string');
  assert.ok(owner.processStartIdentity.length > 0);
  assert.equal(await lockOwnerState(owner), 'ALIVE');
  const snapshot = await readLockSnapshot(file);
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.owner_state, 'ALIVE');
  assert.equal(snapshot.operation, 'recovery_test');
  await release();
  assert.deepEqual(await readLockSnapshot(file), { exists: false });
  await release();
});

test('real live PID remains BUSY and its record is preserved', async t => {
  const { file, hold } = await fixture(t);
  await hold({ heartbeatMs: 60000 });
  const before = await fs.readFile(file, 'utf8');
  await busy(acquireLock(file, { timeout: 200 }));
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal((await readLockSnapshot(file)).owner_state, 'ALIVE');
});

test('a real exited Node child PID allows reclamation', async t => {
  const { file, hold } = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  });
  await once(child, 'spawn');
  const pid = child.pid;
  assert.ok(Number.isInteger(pid));
  await exited;
  const owner = oldOwner({ pid });
  await writeOwner(file, owner);
  assert.equal(await lockOwnerState(owner), 'DEAD');
  assert.equal((await readLockSnapshot(file)).owner_state, 'DEAD');
  await hold({ timeout: 2000 });
  assert.notEqual((await readOwner(file)).token, owner.token);
});

test('same PID with a different injected start identity is reclaimed', async t => {
  const { file, hold } = await fixture(t);
  const owner = oldOwner();
  const inspect = async pid => {
    assert.equal(pid, process.pid);
    return { status: 'ALIVE', identity: 'new-identity' };
  };
  await writeOwner(file, owner);
  assert.equal(await lockOwnerState(owner, inspect), 'PID_REUSED');
  assert.equal((await readLockSnapshot(file, { inspect })).owner_state, 'PID_REUSED');
  await hold({ timeout: 1000, inspect, processStartIdentity: 'new-identity' });
  const current = await readOwner(file);
  assert.notEqual(current.token, owner.token);
  assert.equal(await lockOwnerState(current, inspect), 'ALIVE');
});

test('concurrent reclaimers produce one holder and one BUSY without deleting the winner', async t => {
  const { file } = await fixture(t);
  await writeOwner(file, oldOwner());
  const inspect = async () => ({ status: 'ALIVE', identity: 'current-identity' });
  const options = { timeout: 400, inspect, processStartIdentity: 'current-identity', heartbeatMs: 60000 };
  const releases = [];
  let winner;
  try {
    const results = await Promise.allSettled([0, 1].map(async () => {
      const release = await acquireLock(file, options);
      releases.push(release);
      winner = await fs.readFile(file, 'utf8');
    }));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.filter(result => result.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'BUSY');
    assert.equal(await fs.readFile(file, 'utf8'), winner);
    assert.equal((await readLockSnapshot(file, { inspect })).owner_state, 'ALIVE');
    await assert.rejects(fs.stat(file + '.reclaim'), { code: 'ENOENT' });
  } finally { for (const release of releases) await release(); }
});

test('stale mtime does not authorize reclaiming a real live process', async t => {
  const { file, hold } = await fixture(t);
  await hold({ heartbeatMs: 60000 });
  const before = await fs.readFile(file, 'utf8');
  const old = new Date(Date.now() - 120000);
  await fs.utimes(file, old, old);
  const snapshot = await readLockSnapshot(file);
  assert.equal(snapshot.heartbeat_stale, true);
  assert.equal(snapshot.owner_state, 'ALIVE');
  await busy(acquireLock(file, { timeout: 200 }));
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('release with an old token preserves a replacement record', async t => {
  const { file, hold } = await fixture(t);
  const release = await hold({ heartbeatMs: 60000 });
  const replacement = { ...await readOwner(file), token: 'replacement-token' };
  await writeOwner(file, replacement);
  await release();
  assert.deepEqual(await readOwner(file), replacement);
});

test('UNKNOWN ownership is preserved and acquisition reports BUSY', async t => {
  const { file } = await fixture(t);
  const owner = oldOwner();
  const inspect = async () => ({ status: 'UNKNOWN', identity: null });
  await writeOwner(file, owner);
  const before = await fs.readFile(file, 'utf8');
  assert.equal(await lockOwnerState(owner, inspect), 'UNKNOWN');
  assert.equal((await readLockSnapshot(file, { inspect })).owner_state, 'UNKNOWN');
  await busy(acquireLock(file, { inspect, timeout: 200 }));
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('heartbeat advances mtime and stops after release', async t => {
  const { file, hold } = await fixture(t);
  const release = await hold({ heartbeatMs: 20 });
  const old = new Date(Date.now() - 120000);
  await fs.utimes(file, old, old);
  const initial = (await fs.stat(file)).mtimeMs;
  let advanced = false;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if ((await fs.stat(file)).mtimeMs > initial) { advanced = true; break; }
    await delay(20);
  }
  assert.equal(advanced, true);
  // Preserve the same file/inode so a leaked handle timer remains observable.
  const replacement = { ...await readOwner(file), token: 'heartbeat-replacement' };
  await writeOwner(file, replacement);
  await release();
  await fs.utimes(file, old, old);
  const stopped = (await fs.stat(file)).mtimeMs;
  await delay(150);
  assert.equal((await fs.stat(file)).mtimeMs, stopped);
  assert.deepEqual(await readOwner(file), replacement);
});

test('metadata never records supplied prompt or URL content', async t => {
  const { file, hold } = await fixture(t);
  const prompt = 'PRIVATE_PROMPT_SENTINEL';
  const url = 'https://private.invalid/SECRET_URL_SENTINEL';
  await hold({ operation: url, prompt, url, metadata: { prompt, url } });
  const raw = await fs.readFile(file, 'utf8');
  const owner = JSON.parse(raw);
  assert.deepEqual(Object.keys(owner).sort(), ['pid', 'token', 'operation', 'startedAt', 'processStartIdentity'].sort());
  assert.equal(owner.operation, 'operation');
  for (const output of [raw, JSON.stringify(await readLockSnapshot(file))]) {
    assert.equal(output.includes(prompt), false);
    assert.equal(output.includes(url), false);
    assert.equal(output.includes('SECRET_URL_SENTINEL'), false);
  }
});
