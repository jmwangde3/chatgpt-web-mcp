import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectWindowsBrowserProcess } from '../src/shared/windows-security.js';

function fixture() {
  const expected = {
    pid: 123, port: 9222, profile: 'C:\\synthetic profile',
    executable: 'C:\\Synthetic Chrome\\chrome.exe',
    creationTime: '2026-11-17T00:00:00.000Z',
    startedAt: Date.parse('2026-11-17T00:00:00.000Z'),
  };
  const recorded = {
    pid: expected.pid, parentPid: 100, creationTime: expected.creationTime,
    executable: expected.executable,
    commandLine: `"${expected.executable}" --user-data-dir="${expected.profile}" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1`,
  };
  const listener = { ...recorded, ownerPid: expected.pid, port: expected.port, address: '127.0.0.1' };
  return { expected, evidence: { recorded, listeners: [] }, listener };
}

async function inspect(expected, evidence) {
  let calls = 0;
  const result = await inspectWindowsBrowserProcess(expected, { query: async (script, input) => {
    calls++;
    assert.equal(typeof script, 'string');
    assert.deepEqual(input, { pid: expected.pid, port: expected.port });
    return evidence;
  } });
  assert.equal(calls, 1);
  return result;
}

test('empty Windows process record without a listener means the browser exited', async () => {
  const { expected } = fixture();
  assert.equal((await inspect(expected, { recorded: {}, listeners: [] })).state, 'NOT_RUNNING');
});

test('matching recorded PID without a listener is PROCESS_MATCHED_NO_CDP', async () => {
  const { expected, evidence } = fixture();
  const result = await inspect(expected, evidence);
  assert.equal(result.state, 'PROCESS_MATCHED_NO_CDP');
  assert.equal(result.listener_present, false);
  assert.equal(result.identity.pid, expected.pid);
  assert.equal(result.identity.creationTime, expected.creationTime);
});

test('matching recorded PID and listener are PROCESS_MATCHED', async () => {
  const { expected, evidence, listener } = fixture();
  evidence.listeners.push(listener);
  const result = await inspect(expected, evidence);
  assert.equal(result.state, 'PROCESS_MATCHED');
  assert.equal(result.listener_present, true);
  assert.equal(result.identity.pid, expected.pid);
});

test('missing recorded PID without listeners is NOT_RUNNING', async () => {
  const { expected } = fixture();
  assert.deepEqual(await inspect(expected, { recorded: null, listeners: [] }), { state: 'NOT_RUNNING' });
});

test('missing unenriched parent migrates to a direct child listener created shortly after launch', async () => {
  const { expected, listener } = fixture();
  delete expected.creationTime;
  listener.pid = listener.ownerPid = 456;
  listener.parentPid = expected.pid;
  listener.creationTime = new Date(expected.startedAt + 500).toISOString();
  const result = await inspect(expected, { recorded: null, listeners: [listener] });
  assert.equal(result.state, 'PROCESS_MATCHED');
  assert.equal(result.identity.pid, 456);
  assert.equal(result.identity.creationTime, listener.creationTime);
  assert.equal(result.listener_present, true);
});

for (const [label, mutate] of [
  ['creation time', p => { p.creationTime = '2026-11-17T00:00:01.000Z'; }],
  ['profile', p => { p.commandLine = p.commandLine.replace('synthetic profile', 'other profile'); }],
  ['executable', p => { p.executable = 'C:\\Other\\chrome.exe'; }],
  ['debug address', p => { p.commandLine = p.commandLine.replace('127.0.0.1', '0.0.0.0'); }],
  ['duplicate profile flag', p => { p.commandLine += ' --user-data-dir="C:\\synthetic profile"'; }],
  ['duplicate port flag', p => { p.commandLine += ' --remote-debugging-port=9222'; }],
  ['duplicate address flag', p => { p.commandLine += ' --remote-debugging-address=127.0.0.1'; }],
]) {
  for (const source of ['recorded', 'listener']) {
    test(`rejects mismatched ${label} in ${source}`, async () => {
      const { expected, evidence, listener } = fixture();
      if (source === 'listener') { evidence.listeners.push(listener); mutate(listener); }
      else mutate(evidence.recorded);
      assert.equal((await inspect(expected, evidence)).state, 'IDENTITY_MISMATCH');
    });
  }
}

test('rejects a non-loopback listener address', async () => {
  const { expected, evidence, listener } = fixture();
  listener.address = '0.0.0.0';
  evidence.listeners.push(listener);
  assert.equal((await inspect(expected, evidence)).state, 'IDENTITY_MISMATCH');
});

test('query failure returns UNKNOWN without exposing error content', async () => {
  const { expected } = fixture();
  const result = await inspectWindowsBrowserProcess(expected, { query: async () => {
    throw new Error('PRIVATE_COMMAND_LINE');
  } });
  assert.deepEqual(result, { state: 'UNKNOWN' });
});

for (const recordedPresent of [true, false]) {
  test(`unrelated listener is rejected with recorded PID ${recordedPresent ? 'present' : 'missing'}`, async () => {
    const { expected, evidence, listener } = fixture();
    if (!recordedPresent) { evidence.recorded = null; delete expected.creationTime; }
    listener.pid = listener.ownerPid = 789;
    listener.parentPid = 999;
    evidence.listeners.push(listener);
    assert.equal((await inspect(expected, evidence)).state, 'IDENTITY_MISMATCH');
  });
}

for (const offset of [-1001, 10001]) {
  test(`direct child outside tight creation window (${offset}ms) is rejected`, async () => {
    const { expected, listener } = fixture();
    delete expected.creationTime;
    listener.pid = listener.ownerPid = 456;
    listener.parentPid = expected.pid;
    listener.creationTime = new Date(expected.startedAt + offset).toISOString();
    assert.equal((await inspect(expected, { recorded: null, listeners: [listener] })).state, 'IDENTITY_MISMATCH');
  });
}

for (const mode of ['no-listener', 'listener', 'child']) {
  test(`successful ${mode} result excludes commandLine`, async () => {
    const { expected, evidence, listener } = fixture();
    if (mode !== 'no-listener') evidence.listeners.push(listener);
    if (mode === 'child') {
      evidence.recorded = null;
      delete expected.creationTime;
      listener.pid = listener.ownerPid = 456;
      listener.parentPid = expected.pid;
    }
    const result = await inspect(expected, evidence);
    assert.equal(result.state, mode === 'no-listener' ? 'PROCESS_MATCHED_NO_CDP' : 'PROCESS_MATCHED');
    assert.equal(JSON.stringify(result).includes('commandLine'), false);
    assert.equal(JSON.stringify(result).includes('--user-data-dir'), false);
  });

  test(`${mode} inspection leaves expected and query evidence unchanged`, async () => {
    const { expected, evidence, listener } = fixture();
    if (mode !== 'no-listener') evidence.listeners.push(listener);
    if (mode === 'child') {
      evidence.recorded = null;
      delete expected.creationTime;
      listener.pid = listener.ownerPid = 456;
      listener.parentPid = expected.pid;
    }
    const before = structuredClone({ expected, evidence });
    const result = await inspect(expected, evidence);
    assert.equal(result.state, mode === 'no-listener' ? 'PROCESS_MATCHED_NO_CDP' : 'PROCESS_MATCHED');
    assert.deepEqual(expected, before.expected);
    assert.deepEqual(evidence, before.evidence);
  });
}
