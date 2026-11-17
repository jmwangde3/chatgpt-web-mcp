import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectProcessIdentity } from '../src/shared/process-identity.js';

const pid = 123;
const boot = '01234567-89ab-cdef-0123-456789abcdef';
const stat = state => `${pid} (worker (nested) name)) ${[state, ...Array(18).fill('0'), '98765'].join(' ')}`;
const inspect = value => inspectProcessIdentity(pid, {
  platform: 'linux',
  alive: () => true,
  read: async path => path === `/proc/${pid}/stat` ? value : `${boot}\n`,
});

for (const [state, name] of [['Z', 'zombie'], ['X', 'dead']]) {
  test(`Linux ${name} is DEAD even when alive returns true`, async () => {
    assert.deepEqual(await inspect(stat(state)), { status: 'DEAD', identity: null });
  });
}

test('Linux normal state preserves start time with parentheses in process name', async () => {
  assert.deepEqual(await inspect(stat('S')), { status: 'ALIVE', identity: `linux:${boot}:98765` });
});

for (const [name, value] of [
  ['missing closing parenthesis', `${pid} (worker S ${Array(19).fill('0').join(' ')}`],
  ['missing process name', `) S ${Array(19).fill('0').join(' ')}`],
  ['invalid state', stat('??')],
  ['missing start time', `${pid} (worker) S 0`],
  ['invalid start time', stat('S').replace(/98765$/, 'invalid')],
  ['missing state separator', stat('S').replace(') S', ')S')],
]) {
  test(`Linux malformed stat (${name}) is UNKNOWN`, async () => {
    assert.deepEqual(await inspect(value), { status: 'UNKNOWN', identity: null });
  });
}
