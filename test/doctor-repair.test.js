import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ownProcessIdentity, } from '../src/shared/process-identity.js';
import { writeState } from '../src/shared/persistent-browser.js';
import { readLockSnapshot } from '../src/shared/locks.js';
import { repairStaleLocks } from '../src/core/diagnostics.js';
import { parseManagement } from '../src/management.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-repair-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const taskDirectory = path.join(directory, 'tasks');
  const taskFile = path.join(taskDirectory, 'chatgpt', 'tasks.json');
  await fs.mkdir(path.dirname(taskFile), { recursive: true });
  const journal = { version: 2, active: null, tasks: {} };
  await writeState(taskFile, journal);
  const provider = { id: 'chatgpt', localConfig: {}, browser: {} };
  const kernel = {
    directory: taskDirectory,
    providers: new Map([['chatgpt', provider]]),
    provider: id => { if (id !== 'chatgpt') throw new Error('unknown provider'); return provider; },
    verifyStorage: async () => {},
  };
  return { directory, taskFile, kernel };
}

test('doctor repair reclaims a lock only when the owner is independently DEAD', async t => {
  const f = await fixture(t);
  const lock = f.taskFile + '.lock';
  await fs.writeFile(lock, JSON.stringify({
    pid: 2147483647, token: 'dead-owner-token', operation: 'task-journal',
    startedAt: Date.now() - 60000, processStartIdentity: 'windows:dead-owner',
  }));
  const journalBefore = await fs.readFile(f.taskFile);
  const inspect = async pid => pid === 2147483647 ? { status: 'DEAD', identity: null } : { status: 'ALIVE', identity: await ownProcessIdentity() };
  const result = await repairStaleLocks(f.kernel, ['chatgpt'], {
    verifyPaths: async config => {
      assert.equal(config.profile, undefined);
      assert.deepEqual(config.dataDirectories, [path.dirname(f.taskFile)]);
    }, inspect,
  });
  assert.equal(result.ok, true);
  assert.equal(result.locks.find(item => item.lock === 'task_lock').status, 'reclaimed');
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(f.taskFile), journalBefore);
  assert.equal(result.task_journal_modified, false);
  assert.equal(result.uncertain_tasks_modified, false);
});

test('doctor repair reclaims a PID-reused lock only when process-start identity mismatches', async t => {
  const f = await fixture(t);
  const lock = f.taskFile + '.lock';
  const currentIdentity = await ownProcessIdentity();
  await fs.writeFile(lock, JSON.stringify({
    pid: process.pid, token: 'reused-owner-token', operation: 'task-journal',
    startedAt: Date.now() - 60000, processStartIdentity: 'stale-process-start-identity',
  }));
  const journalBefore = await fs.readFile(f.taskFile);
  const inspect = async pid => pid === process.pid
    ? { status: 'ALIVE', identity: currentIdentity }
    : { status: 'UNKNOWN', identity: null };
  const result = await repairStaleLocks(f.kernel, ['chatgpt'], { verifyPaths: async () => {}, inspect });
  assert.equal(result.locks.find(item => item.lock === 'task_lock').previous_owner_state, 'PID_REUSED');
  assert.equal(result.locks.find(item => item.lock === 'task_lock').status, 'reclaimed');
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(f.taskFile), journalBefore);
});

test('doctor repair preserves LIVE and UNKNOWN lock owners', async t => {
  const f = await fixture(t);
  const liveLock = f.taskFile + '.lock';
  await fs.writeFile(liveLock, JSON.stringify({
    pid: process.pid, token: 'live-owner-token', operation: 'task-journal',
    startedAt: Date.now(), processStartIdentity: await ownProcessIdentity(),
  }));
  const inspect = async pid => pid === process.pid ? { status: 'ALIVE', identity: await ownProcessIdentity() } : { status: 'UNKNOWN', identity: null };
  const liveResult = await repairStaleLocks(f.kernel, ['chatgpt'], { verifyPaths: async () => {}, inspect });
  assert.equal(liveResult.locks.find(item => item.lock === 'task_lock').status, 'preserved');
  assert.equal((await readLockSnapshot(liveLock)).owner_state, 'ALIVE');

  await fs.writeFile(liveLock, JSON.stringify({ pid: process.pid, token: 'unknown-owner-token' }));
  const unknownResult = await repairStaleLocks(f.kernel, ['chatgpt'], { verifyPaths: async () => {}, inspect: async () => ({ status: 'ALIVE', identity: null }) });
  assert.equal(unknownResult.locks.find(item => item.lock === 'task_lock').status, 'preserved');
  assert.equal((await readLockSnapshot(liveLock)).owner_state, 'UNKNOWN');
});

test('doctor --repair is an explicit CLI option', () => {
  const parsed = parseManagement('doctor', ['--repair', '--provider', 'chatgpt']);
  assert.equal(parsed.repair, true);
  assert.equal(parsed.provider, 'chatgpt');
});
