import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLinuxBrowserProcess, verifyLinuxBrowserProcess } from '../src/shared/native-browser-identity.js';

const launcher = '/usr/bin/google-chrome';
const scriptPath = '/opt/google/chrome/google-chrome';
const runtime = '/opt/google/chrome/chrome';
const wrapper = '#!/bin/bash\nHERE="$(dirname "$(readlink -f "$0")")"\nexec -a "$0" "$HERE/chrome" "$@"\n';
function fixture(options = {}) {
  const expected = { pid: 42, port: 9222, profile: '/profiles/dedicated', executable: launcher };
  const command = `chrome\0--user-data-dir=${expected.profile}\0--remote-debugging-port=9222\0--remote-debugging-address=127.0.0.1\0`;
  const files = new Map([
    [scriptPath, Buffer.from(options.wrapper ?? wrapper)],
    [runtime, Buffer.from([127, 69, 76, 70, 2])],
    ['/proc/42/cmdline', options.command ?? command],
    ['/proc/42/net/tcp', `header\n 0: ${options.address ?? '0100007F'}:${options.port ?? '2406'} 00000000:0000 0A 0 0 0 0 0 ${options.inode ?? '123'}\n`],
  ]);
  const deps = {
    read: async p => { if (!files.has(p)) throw Error('secret/path'); return files.get(p); },
    realpath: async p => p === launcher ? (options.direct ? runtime : scriptPath) : p,
    readlink: async p => p.endsWith('/exe') ? (options.exe ?? runtime) : 'socket:[123]',
    readdir: async () => ['9'],
    inspect: async () => options.process ?? { status: 'ALIVE', identity: 'linux:boot:123' },
  };
  return { expected, deps };
}
const run = (f, extra = {}) => inspectLinuxBrowserProcess({ ...f.expected, ...extra }, f.deps);

test('Linux verifies symlink to ELF and known shell wrapper preserving PID', async () => {
  for (const direct of [true, false]) {
    const f = fixture({ direct });
    const result = await run(f);
    assert.equal(result.state, 'PROCESS_MATCHED');
    assert.equal(result.identity.executable, runtime);
    assert.equal(result.identity.runtimeExecutable, runtime);
    assert.equal(result.identity.launcherExecutable, launcher);
    assert.deepEqual(await verifyLinuxBrowserProcess(f.expected, f.deps), result.identity);
    assert.equal((await run(f, { ...result.identity, executable: launcher })).state, 'PROCESS_MATCHED');
    assert.equal((await run(f, result.identity)).state, 'PROCESS_MATCHED');
  }
});

test('Linux verifies the Chromium distribution wrapper and braced positional argument', async () => {
  const packaged = '#!/bin/bash\nexport CHROME_WRAPPER="`readlink -f "$0"`"\nHERE="`dirname "$CHROME_WRAPPER"`"\nexec < /dev/null\nexec > >(exec cat)\nexec 2> >(exec cat >&2)\nexec -a "$0" "$HERE/chrome" "$@"\n';
  for (const source of [packaged, wrapper.replace('readlink -f "$0"', 'readlink -f "${0}"')]) {
    assert.equal((await run(fixture({ wrapper: source }))).state, 'PROCESS_MATCHED');
  }
});

test('Linux rejects basename matches, changed launcher/runtime and start identity', async () => {
  assert.equal((await run(fixture({ exe: '/untrusted/chrome' }))).reason, 'EXECUTABLE_MISMATCH');
  const f = fixture();
  assert.equal((await run(f, { runtimeExecutable: '/other/chrome' })).reason, 'EXECUTABLE_MISMATCH');
  assert.equal((await run(f, { launcherExecutable: '/other/launcher', runtimeExecutable: runtime })).reason, 'LAUNCHER_CHANGED');
  assert.equal((await run(f, { processStartIdentity: 'old' })).reason, 'PROCESS_START_CHANGED');
});

test('Linux fails closed on unsupported wrappers and packaging', async () => {
  for (const script of [
    '#!/bin/sh\nexec snap run chromium "$@"',
    '#!/bin/sh\nexec flatpak run browser "$@"',
    '#!/bin/sh\nexec "$UNKNOWN/chrome" "$@"',
    wrapper.replace('exec -a', 'HERE="/untrusted"\nexec -a'),
    wrapper.replace('"$HERE/chrome"', '"$(find-browser)"'),
    wrapper + 'exec /other/chrome "$@"\n',
  ]) assert.equal((await run(fixture({ wrapper: script }))).reason, 'UNSUPPORTED_LAUNCHER');
});

test('Linux requires exact profile, unique flags, port and loopback', async () => {
  const f = fixture();
  for (const command of [
    'chrome\0--remote-debugging-port=9222\0--remote-debugging-address=127.0.0.1\0',
    'chrome\0--user-data-dir=/other\0--remote-debugging-port=9222\0--remote-debugging-address=127.0.0.1\0',
    'chrome\0--user-data-dir=/profiles/dedicated\0--remote-debugging-port=9223\0--remote-debugging-address=127.0.0.1\0',
    'chrome\0--user-data-dir=/profiles/dedicated\0--remote-debugging-port=9222\0--remote-debugging-address=0.0.0.0\0',
    'chrome\0--user-data-dir=/profiles/dedicated\0--user-data-dir=/profiles/dedicated\0--remote-debugging-port=9222\0--remote-debugging-address=127.0.0.1\0',
  ]) assert.equal((await run(fixture({ command }))).reason, 'ARGUMENT_MISMATCH');
  assert.equal((await run(f, { port: 0 })).reason, 'INVALID_EXPECTATION');
});

test('Linux listener must belong to verified PID on exact loopback port', async () => {
  for (const option of [{ inode: '999' }, { address: '00000000' }, { port: '2407' }]) {
    const f = fixture(option);
    assert.equal((await run(f)).state, 'PROCESS_MATCHED_NO_CDP');
    await assert.rejects(verifyLinuxBrowserProcess(f.expected, f.deps), { code: 'BROWSER_NO_CDP' });
  }
});

test('Linux preserves unknown/dead status and redacts read failures', async () => {
  assert.equal((await run(fixture({ process: { status: 'DEAD' } }))).state, 'NOT_RUNNING');
  assert.equal((await run(fixture({ process: { status: 'UNKNOWN' } }))).state, 'UNKNOWN');
  const f = fixture();
  f.deps.read = async () => { throw Error('/private/profile secret'); };
  assert.deepEqual(await run(f), { state: 'UNKNOWN', reason: 'IDENTITY_READ_FAILED' });
});

test('Linux detects PID reuse during listener inspection and bounds FD reads', async () => {
  const f = fixture();
  let calls = 0;
  f.deps.inspect = async () => ({ status: 'ALIVE', identity: ++calls === 1 ? 'start' : 'reused' });
  assert.equal((await run(f)).reason, 'PROCESS_CHANGED_DURING_CHECK');
  const g = fixture();
  g.deps.readdir = async () => Array(4097).fill('9');
  assert.equal((await run(g)).reason, 'FD_LIMIT_EXCEEDED');
});
