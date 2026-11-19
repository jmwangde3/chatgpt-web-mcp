import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskKernel, journalStatistics, validateJournal } from '../src/core/tasks.js';
import { acquireLock, writeState } from '../src/shared/persistent-browser.js';

const task = (id, state = 'running', extra = {}) => ({ task_id: id, provider: 'chatgpt', session_id: id, state, created_at: 1000, updated_at: 1000, blocking: !['completed', 'failed', 'cancelled', 'abandoned'].includes(state), ...extra });
const journal = (...tasks) => ({ version: 2, active: null, tasks: Object.fromEntries(tasks.map(t => [t.task_id, t])) });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-snapshot-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { kernel: new TaskKernel([{ id: 'chatgpt' }], { directory, verifyStoragePaths: async () => {} }), file: path.join(directory, 'chatgpt', 'tasks.json') };
}

test('snapshot list and request lookup finish while a real live journal lock remains held', async t => {
  const { kernel, file } = await fixture(t);
  const requestHash = createHash('sha256').update(JSON.stringify('request')).digest('hex');
  await writeState(file, journal(task('one', 'running', { requestHash, promptHash: 'PRIVATE', baseline: { prompt: 'PRIVATE' }, response: { text: 'PRIVATE' }, previous_response: { text: 'PRIVATE' } })));
  const release = await acquireLock(file + '.lock');
  const lockBefore = await fs.readFile(file + '.lock');
  const before = await fs.readFile(file);
  let timer;
  try {
    const [list, found] = await Promise.race([
      Promise.all([kernel.list('chatgpt'), kernel.findRequest('chatgpt', 'request')]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('snapshot blocked on live lock')), 1500); }),
    ]);
    assert.equal(list.total, 1);
    assert.equal(found.task_id, 'one');
    assert.equal(await kernel.findRequest('chatgpt', 'missing'), null);
    assert.equal(JSON.stringify(list).includes('PRIVATE'), false);
    assert.deepEqual(await fs.readFile(file + '.lock'), lockBefore);
    assert.deepEqual(await fs.readFile(file), before);
  } finally { clearTimeout(timer); await release(); }
});

test('atomic rename readers see only complete old or new validated snapshots', async t => {
  const { kernel, file } = await fixture(t);
  const old = journal(task('old'));
  const next = journal(task('new', 'completed'));
  await writeState(file, old);
  const seen = [];
  const writer = async () => {
    for (let i = 0; i < 60; i++) {
      // Exercise the production writer's bounded retries, with no synthetic
      // retry wrapper hiding a publication failure under concurrent reads.
      await writeState(file, i % 2 ? old : next);
    }
  };
  const reader = async () => {
    for (let i = 0; i < 120; i++) {
      const snapshot = await kernel.readSnapshot('chatgpt');
      assert.ok(JSON.stringify(snapshot) === JSON.stringify(old) || JSON.stringify(snapshot) === JSON.stringify(next));
      seen.push(snapshot);
    }
  };
  const results = await Promise.allSettled([writer(), reader(), reader()]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  assert.equal(seen.length, 240);
});

test('invalid journals fail reads without rewriting any bytes', async t => {
  const { kernel, file } = await fixture(t);
  for (const raw of ['{broken', 'null', JSON.stringify(journal(task('one'), task('two', 'running', { session_id: 'one' }))), JSON.stringify({ version: 1, active: null, tasks: { legacy: task('legacy', 'running', { session_id: undefined }) } })]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, raw, 'utf8');
    const before = await fs.readFile(file);
    for (const read of [() => kernel.readSnapshot('chatgpt'), () => kernel.list('chatgpt'), () => kernel.findRequest('chatgpt', 'request')]) await assert.rejects(read);
    assert.deepEqual(await fs.readFile(file), before);
    await assert.rejects(fs.stat(file + '.lock'), { code: 'ENOENT' });
  }
});

test('statistics count state occupancy, blocking mismatches and legacy sessions without exposing content', () => {
  const legacy = task('legacy', 'uncertain', { session_id: undefined, blocking: false, prompt: 'PRIVATE', conversation_url: 'PRIVATE' });
  const state = journal(legacy, task('named'), task('done', 'completed', { blocking: true }));
  state.active = 'legacy';
  validateJournal(state, 'chatgpt');
  const before = JSON.stringify(state);
  assert.deepEqual(journalStatistics(state, { now: 10000 }), {
    total_count: 3, state_counts: { uncertain: 1, running: 1, completed: 1 }, active_count: 2,
    blocking_count: 2, blocking_flag_mismatch_count: 2, active_session_count: 2,
    legacy_identity_unverified_count: 1, send_unconfirmed_count: 0,
    oldest_active_task: { state: 'uncertain', created_at: 1000 }, oldest_active_age_ms: 9000, oldest_active_state: 'uncertain',
    oldest_uncertain_age_ms: 9000,
  });
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(journalStatistics(journal(), { now: 10000 }), {
    total_count: 0, state_counts: {}, active_count: 0, blocking_count: 0, blocking_flag_mismatch_count: 0,
    active_session_count: 0, oldest_active_task: null, oldest_active_age_ms: null, oldest_active_state: null,
    legacy_identity_unverified_count: 0, send_unconfirmed_count: 0, oldest_uncertain_age_ms: null,
  });
});

test('list aging is derived, respects strict thresholds, and never fails old running tasks', async t => {
  const { kernel, file } = await fixture(t);
  const now = 2000000;
  const state = journal(task('submitted', 'submitted', { submitted_at: now - 20000 }), task('uncertain', 'uncertain', { updated_at: now - 600000 }), task('running'));
  await writeState(file, state);
  const before = await fs.readFile(file);
  const clock = t.mock.method(Date, 'now', () => now);
  const first = await kernel.list('chatgpt');
  assert.ok(first.tasks.every(t => t.age_classification === null));
  clock.mock.mockImplementation(() => now + 1);
  const list = await kernel.list('chatgpt');
  const byId = Object.fromEntries(list.tasks.map(t => [t.task_id, t]));
  assert.equal(byId.submitted.age_classification, 'NEEDS_RECONCILIATION');
  assert.equal(byId.uncertain.age_classification, 'NEEDS_USER_REVIEW');
  assert.equal(byId.running.age_classification, null);
  assert.equal(byId.running.state, 'running');
  const page = await kernel.list('chatgpt', 1, { state: 'submitted' });
  assert.equal(page.total, 1);
  assert.equal(page.next_offset, null);
  assert.equal(page.active_tasks.length, 3);
  assert.deepEqual(await fs.readFile(file), before);
});
