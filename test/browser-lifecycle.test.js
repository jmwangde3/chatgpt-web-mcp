import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PersistentBrowser as AgentPersistentBrowser } from '../src/shared/persistent-browser.js';

// No real CDP, fetch, spawn or process termination is used. The current Node PID
// only satisfies connect's synchronous liveness check for the migrated child.
async function fixture(t, { legacy = false } = {}) {
  const directory = await fs.mkdtemp(fileURLToPath(new URL('../.browser-lifecycle-', import.meta.url)));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const config = { browserState: path.join(directory, 'state.json'), profile: directory,
    executable: path.join(directory, 'chrome.exe'), actionTimeout: 300 };
  const child = { pid: process.pid, port: 19321, creationTime: '20261117010101.000000+000',
    profile: config.profile, executable: config.executable, startedAt: 123 };
  const parent = { ...child, pid: 2147483647, creationTime: '20261116010101.000000+000' };
  const initial = legacy ? parent : child;
  const bytes = Buffer.from(`${JSON.stringify(initial, null, 4)}\r\n`);
  await fs.writeFile(config.browserState, bytes);
  const calls = { commands: [], disconnects: 0, inspected: [], verified: [], assessments: [], connections: [] };
  const f = { config, child, parent, bytes, calls, reachable: true,
    assessment: 'PROCESS_MATCHED', onClose: async () => {},
    inspect: async () => ({ status: 'DEAD' }),
    verify: async () => ({ ...child }) };
  const context = new EventEmitter();
  context.pages = () => [];
  context.setDefaultTimeout = () => {};
  const browser = new EventEmitter();
  let connected = true;
  browser.contexts = () => [context];
  browser.isConnected = () => connected;
  browser.newBrowserCDPSession = async () => ({ send: async command => {
    calls.commands.push(command);
    assert.equal(command, 'Browser.close');
    await f.onClose();
  } });
  browser.close = async () => { calls.disconnects++; connected = false; browser.emit('disconnected'); };
  f.runtime = new AgentPersistentBrowser(config, {
    security: {
      paths: async value => assert.equal(value, config),
      // Independent Windows assessment; deliberately not derived from inspectPID.
      inspect: async state => { calls.assessments.push({ ...state }); return { state: f.assessment }; },
      process: async state => { calls.verified.push({ ...state }); return f.verify(state); },
    },
    fetchImpl: async url => {
      assert.equal(url, `http://127.0.0.1:${child.port}/json/version`);
      return { ok: f.reachable, json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${child.port}/devtools/browser/mock` }) };
    },
    connect: async endpoint => { calls.connections.push(endpoint); return browser; },
    inspectPID: async pid => { calls.inspected.push(pid); return f.inspect(pid); },
    spawnImpl: () => assert.fail('must never launch Chrome'),
  });
  f.readBytes = () => fs.readFile(config.browserState);
  f.assertOneClose = () => { assert.deepEqual(calls.commands, ['Browser.close']); assert.equal(calls.disconnects, 1); };
  return f;
}

test('exited parent with listening port migrates to verified child before terminating', async t => {
  const f = await fixture(t, { legacy: true });
  f.onClose = async () => {
    assert.deepEqual(JSON.parse(await f.readBytes()), f.child);
    f.reachable = false;
  };
  assert.deepEqual(await f.runtime.terminate(), { closed: true });
  assert.equal(f.calls.assessments[0].pid, f.parent.pid);
  assert.equal(f.calls.verified[0].pid, f.parent.pid);
  assert.equal(f.calls.verified.at(-1).pid, f.child.pid);
  assert.deepEqual(f.calls.inspected, [f.child.pid]);
  assert.equal(f.calls.connections.length, 1);
  f.assertOneClose();
  await assert.rejects(f.readBytes(), { code: 'ENOENT' });
});

test('termination waits for child identity to end, not the already dead parent', async t => {
  const f = await fixture(t, { legacy: true });
  let probes = 0;
  f.onClose = async () => { f.reachable = false; };
  f.inspect = async pid => {
    assert.equal(pid, f.child.pid);
    if (++probes === 1) return { status: 'ALIVE', identity: `windows:${f.child.creationTime}` };
    assert.deepEqual(JSON.parse(await f.readBytes()), f.child);
    return { status: 'DEAD' };
  };
  assert.deepEqual(await f.runtime.terminate(), { closed: true });
  assert.equal(probes, 2);
  f.assertOneClose();
});

test('dead child with reachable port cannot report closed or delete state', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.terminate(), { code: 'CLOSE_TIMEOUT' });
  assert.ok(f.calls.inspected.length > 0);
  assert.ok(f.calls.inspected.every(pid => pid === f.child.pid));
  assert.deepEqual(await f.readBytes(), f.bytes);
  f.assertOneClose();
});

test('each instance identity field protects replacement state during close', async t => {
  const changes = { pid: 2147483646, port: 19322, creationTime: 'new-creation',
    processStartIdentity: 'new-start', profile: 'new-profile', executable: 'new-exe' };
  for (const [field, value] of Object.entries(changes)) {
    await t.test(field, async t => {
      const f = await fixture(t);
      const replacement = Buffer.from(`${JSON.stringify({ ...f.child, [field]: value }, null, 3)}\r\n`);
      f.onClose = async () => { await fs.writeFile(f.config.browserState, replacement); f.reachable = false; };
      await assert.rejects(f.runtime.terminate(), { code: 'BROWSER_STATE_CHANGED' });
      assert.deepEqual(await f.readBytes(), replacement);
      f.assertOneClose();
    });
  }
});

test('identity mismatch performs zero close operations and preserves bytes', async t => {
  const f = await fixture(t);
  f.assessment = 'IDENTITY_MISMATCH';
  await assert.rejects(f.runtime.terminate(), { code: 'BROWSER_IDENTITY_MISMATCH' });
  assert.deepEqual(f.calls.commands, []);
  assert.equal(f.calls.disconnects, 0);
  assert.equal(f.calls.connections.length, 0);
  assert.deepEqual(await f.readBytes(), f.bytes);
});

test('unknown identity is never treated as confirmed closure', async t => {
  await t.test('independent assessment UNKNOWN prevents any close', async t => {
    const f = await fixture(t);
    f.assessment = 'UNKNOWN';
    await assert.rejects(f.runtime.terminate(), { code: 'BROWSER_IDENTITY_MISMATCH' });
    assert.deepEqual(f.calls.commands, []);
    assert.equal(f.calls.disconnects, 0);
    assert.deepEqual(await f.readBytes(), f.bytes);
  });
  await t.test('UNKNOWN after close cannot report closed even with offline port', async t => {
    const f = await fixture(t);
    f.onClose = async () => { f.reachable = false; };
    f.inspect = async () => ({ status: 'UNKNOWN' });
    await assert.rejects(f.runtime.terminate(), { code: 'CLOSE_TIMEOUT' });
    assert.ok(f.calls.inspected.length > 0);
    assert.deepEqual(await f.readBytes(), f.bytes);
    f.assertOneClose();
  });
});

test('close timeout with the original identity alive retains exact original bytes', async t => {
  const f = await fixture(t);
  f.onClose = async () => { f.reachable = false; };
  f.inspect = async () => ({ status: 'ALIVE', identity: `windows:${f.child.creationTime}` });
  await assert.rejects(f.runtime.terminate(), { code: 'CLOSE_TIMEOUT' });
  assert.ok(f.calls.inspected.length > 0);
  assert.deepEqual(await f.readBytes(), f.bytes);
  f.assertOneClose();
});
