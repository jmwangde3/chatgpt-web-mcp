import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PersistentBrowser, readState, writeState } from '../src/shared/persistent-browser.js';

const failure = code => Object.assign(new Error(code), { code });
const clone = value => structuredClone(value);

function publicationFS({ failures = [], stage } = {}) {
  const target = path.resolve('publication-mock.json');
  const original = 'original bytes\r\n';
  const files = new Map([[target, original]]);
  const events = [], waits = [];
  let attempts = 0, temporary;
  const fsImpl = {
    mkdir: async () => {},
    open: async (file, flags, mode) => {
      events.push('open');
      assert.equal(flags, 'wx'); assert.equal(mode, 0o600);
      assert.notEqual(file, target); assert.equal(path.dirname(file), path.dirname(target));
      temporary = file; files.set(file, '');
      return {
        writeFile: async value => { events.push('write'); if (stage === 'write') throw failure('EIO'); files.set(file, value); },
        sync: async () => { events.push('sync'); if (stage === 'sync') throw failure('EIO'); },
        close: async () => { events.push('close'); },
      };
    },
    rename: async (from, to) => {
      events.push('rename'); attempts++;
      assert.equal(from, temporary); assert.equal(to, target);
      assert.deepEqual(events.slice(0, 4), ['open', 'write', 'sync', 'close']);
      const code = failures[attempts - 1];
      if (code) throw failure(code);
      files.set(to, files.get(from)); files.delete(from);
    },
    unlink: async file => { events.push('unlink'); assert.equal(file, temporary); files.delete(file); },
  };
  return { target, original, files, events, waits, fsImpl,
    delayImpl: async ms => { waits.push(ms); }, get attempts() { return attempts; },
    assertClean() { assert.deepEqual([...files.keys()], [target]); } };
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`writeState retries ${code} four times then publishes on the fifth rename`, async () => {
    const f = publicationFS({ failures: Array(4).fill(code) });
    await writeState(f.target, { pid: 123 }, f);
    assert.equal(f.attempts, 5); assert.deepEqual(f.waits, [10, 20, 40, 80]);
    assert.deepEqual(JSON.parse(f.files.get(f.target)), { pid: 123 });
    assert.equal(f.events.at(-1), 'unlink'); f.assertClean();
  });
  test(`writeState stops after five persistent ${code} errors and preserves the target`, async () => {
    const f = publicationFS({ failures: Array(6).fill(code) });
    await assert.rejects(writeState(f.target, { pid: 123 }, f), { code });
    assert.equal(f.attempts, 5); assert.deepEqual(f.waits, [10, 20, 40, 80]);
    assert.equal(f.files.get(f.target), f.original); f.assertClean();
  });
}

test('writeState does not retry a permanent rename error', async () => {
  const f = publicationFS({ failures: ['EIO'] });
  await assert.rejects(writeState(f.target, {}, f), { code: 'EIO' });
  assert.equal(f.attempts, 1); assert.deepEqual(f.waits, []);
  assert.equal(f.files.get(f.target), f.original); f.assertClean();
});

for (const stage of ['write', 'sync']) {
  test(`writeState closes and cleans its temporary file after ${stage} failure`, async () => {
    const f = publicationFS({ stage });
    await assert.rejects(writeState(f.target, {}, f), { code: 'EIO' });
    assert.equal(f.attempts, 0); assert.deepEqual(f.events.slice(-2), ['close', 'unlink']);
    assert.equal(f.files.get(f.target), f.original); f.assertClean();
  });
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.state-publication-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { browserState: path.join(directory, 'state.json'), profile: path.join(directory, 'profile'),
    executable: 'mock-chrome.exe', url: 'about:blank', actionTimeout: 500 };
  const intentPath = `${config.browserState}.launch-intent.json`;
  const files = new Map(), events = [];
  const f = { config, intentPath, files, events, spawns: 0, attachments: 0, reachable: true,
    assessment: 'PROCESS_MATCHED', failWrite: () => false, spawnError: null };
  const child = new EventEmitter(); child.pid = process.pid; child.exitCode = null;
  child.unref = () => { events.push('unref'); assert.ok(files.has(config.browserState)); };
  f.child = child;
  const stateIO = {
    read: async (file, missingValue = {}) => files.has(file) ? clone(files.get(file)) : missingValue,
    write: async (file, value) => {
      const label = file === intentPath ? (value.pid ? 'intent-pid' : 'intent') : 'state';
      events.push(`write:${label}`);
      if (f.failWrite(label)) throw failure('EIO');
      files.set(file, clone(value)); events.push(`durable:${label}`);
    },
    unlink: async file => { assert.equal(file, intentPath); events.push('unlink:intent'); files.delete(file); },
  };
  f.intent = (extra = {}) => ({ profile: config.profile, executable: config.executable,
    port: 23456, startedAt: Date.now(), launchId: 'test-launch', pid: process.pid, ...extra });
  f.runtime = () => {
    const context = new EventEmitter(); context.pages = () => []; context.setDefaultTimeout = () => {};
    const browser = new EventEmitter(); browser.contexts = () => [context]; browser.isConnected = () => true;
    browser.close = async () => {};
    const runtime = new PersistentBrowser(config, {
      stateIO,
      security: { paths: async () => {}, inspect: async state => {
        events.push('inspect'); assert.equal(state.pid, process.pid); return { state: f.assessment };
      }, process: async state => { events.push('verify'); return { ...state }; } },
      spawnImpl: (executable, args) => {
        f.spawns++; events.push('spawn'); assert.equal(executable, config.executable);
        const intent = files.get(intentPath);
        assert.ok(intent); assert.equal(intent.pid, undefined); assert.ok(intent.launchId);
        assert.equal(intent.profile, config.profile); assert.equal(intent.executable, executable);
        assert.ok(Number.isFinite(intent.startedAt));
        assert.ok(args.includes(`--remote-debugging-port=${intent.port}`));
        if (f.spawnError) throw f.spawnError;
        return child;
      },
      fetchImpl: async url => ({ ok: f.reachable, json: async () => ({
        webSocketDebuggerUrl: `ws://127.0.0.1:${new URL(url).port}/devtools/browser/mock`,
      }) }),
      connect: async () => { f.attachments++; events.push('attach'); return browser; },
    });
    runtime.diagnostic = async () => {};
    return runtime;
  };
  return f;
}

test('readState forwards a missing sentinel but preserves JSON null and empty objects', async t => {
  const f = await fixture(t), sentinel = Symbol('missing');
  assert.equal(await readState(f.intentPath, sentinel), sentinel);
  for (const value of [null, {}]) {
    await fs.writeFile(f.intentPath, JSON.stringify(value), 'utf8');
    assert.deepEqual(await readState(f.intentPath, sentinel), value);
  }
});

test('initial intent publication failure prevents spawn', async t => {
  const f = await fixture(t); f.failWrite = label => label === 'intent';
  await assert.rejects(f.runtime().connect(), { code: 'EIO' });
  assert.equal(f.spawns, 0); assert.equal(f.attachments, 0); assert.equal(f.files.size, 0);
});

test('successful launch publishes state before unref and intent removal', async t => {
  const f = await fixture(t); await f.runtime().connect();
  assert.deepEqual(f.events.slice(0, 9), ['write:intent', 'durable:intent', 'spawn',
    'write:intent-pid', 'durable:intent-pid', 'write:state', 'durable:state', 'unref', 'unlink:intent']);
  assert.equal(f.spawns, 1); assert.equal(f.attachments, 1);
  assert.equal(f.files.get(f.config.browserState).pid, process.pid);
  assert.deepEqual(Object.keys(f.files.get(f.config.browserState)).sort(),
    ['executable', 'launchId', 'pid', 'port', 'profile', 'startedAt'].sort());
  assert.equal(f.files.has(f.intentPath), false);
});

test('same runtime retains its child until recovered state is durable', async t => {
  const f = await fixture(t), runtime = f.runtime();
  f.failWrite = label => label === 'state';
  await assert.rejects(runtime.connect(), { code: 'EIO' });
  assert.equal(runtime.launchChild, f.child);
  assert.equal(runtime.pendingLaunch.port, f.files.get(f.intentPath).port);
  f.failWrite = () => false; f.events.length = 0;
  await runtime.connect();
  assert.equal(f.spawns, 1);
  assert.ok(f.events.indexOf('durable:state') < f.events.indexOf('unref'));
  assert.ok(f.events.indexOf('unref') < f.events.indexOf('unlink:intent'));
  assert.equal(runtime.launchChild, null); assert.equal(runtime.pendingLaunch, null);
});

test('state publication failure recovers in a new runtime without a second spawn', async t => {
  const f = await fixture(t); f.failWrite = label => label === 'state';
  await assert.rejects(f.runtime().connect(), { code: 'EIO' });
  assert.equal(f.spawns, 1); assert.equal(f.files.has(f.config.browserState), false);
  const intent = clone(f.files.get(f.intentPath)); assert.equal(intent.pid, process.pid);
  assert.equal(f.events.includes('unref'), false); assert.equal(f.events.includes('unlink:intent'), false);
  f.failWrite = () => false; f.events.length = 0;
  await f.runtime().connect();
  assert.equal(f.spawns, 1); assert.equal(f.attachments, 1);
  assert.deepEqual(f.files.get(f.config.browserState), intent);
  assert.ok(f.events.indexOf('inspect') < f.events.indexOf('write:state'));
  assert.ok(f.events.indexOf('verify') < f.events.indexOf('write:state'));
  assert.ok(f.events.indexOf('durable:state') < f.events.indexOf('unlink:intent'));
  assert.equal(f.files.has(f.intentPath), false);
});

for (const [name, value] of [['no PID', undefined], ['empty object', {}], ['JSON null', null]]) {
  test(`${name} intent fails closed without spawn or attachment`, async t => {
    const f = await fixture(t);
    const intent = name === 'no PID' ? f.intent({ pid: undefined }) : value;
    f.files.set(f.intentPath, clone(intent));
    await assert.rejects(f.runtime().connect(), { code: 'BROWSER_LAUNCH_UNCERTAIN' });
    assert.equal(f.spawns, 0); assert.equal(f.attachments, 0);
    assert.deepEqual(f.files.get(f.intentPath), intent);
    assert.equal(f.files.has(f.config.browserState), false);
  });
}

test('PID intent publication failure retains the child and pending launch; retry never spawns', async t => {
  const f = await fixture(t); f.failWrite = label => label === 'intent-pid';
  const runtime = f.runtime();
  await assert.rejects(runtime.connect(), { code: 'EIO' });
  assert.equal(runtime.launchChild, f.child); assert.equal(runtime.pendingLaunch.pid, process.pid);
  assert.equal(f.files.get(f.intentPath).pid, undefined);
  assert.equal(f.events.includes('unref'), false);
  f.failWrite = () => false;
  for (const next of [runtime, f.runtime()]) {
    await assert.rejects(next.connect(), { code: 'BROWSER_LAUNCH_UNCERTAIN' });
  }
  assert.equal(f.spawns, 1); assert.equal(f.attachments, 0);
});

test('synchronous spawn failure preserves a no-PID intent and prevents retry', async t => {
  const f = await fixture(t); f.spawnError = failure('SPAWN_FAILED');
  await assert.rejects(f.runtime().connect(), { code: 'SPAWN_FAILED' });
  assert.equal(f.files.get(f.intentPath).pid, undefined);
  assert.equal(f.files.has(f.config.browserState), false);
  await assert.rejects(f.runtime().connect(), { code: 'BROWSER_LAUNCH_UNCERTAIN' });
  assert.equal(f.spawns, 1); assert.equal(f.events.includes('unref'), false);
});

test('unreachable PID intent fails closed without a replacement spawn', async t => {
  const f = await fixture(t); f.files.set(f.intentPath, f.intent()); f.reachable = false;
  await assert.rejects(f.runtime().connect(), { code: 'BROWSER_LAUNCH_UNCERTAIN' });
  assert.equal(f.spawns, 0); assert.equal(f.attachments, 0); assert.ok(f.files.has(f.intentPath));
});

test('intent recovery rejects an unverified process identity', async t => {
  const f = await fixture(t); f.files.set(f.intentPath, f.intent()); f.assessment = 'IDENTITY_MISMATCH';
  await assert.rejects(f.runtime().connect(), { code: 'BROWSER_IDENTITY_MISMATCH' });
  assert.equal(f.spawns, 0); assert.equal(f.attachments, 0);
  assert.equal(f.files.has(f.config.browserState), false); assert.ok(f.files.has(f.intentPath));
});
