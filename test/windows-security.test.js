import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWindowsIdentity, validateSecuritySnapshot } from '../src/shared/windows-security.js';

function identity() {
  const expected = {
    pid: 123,
    port: 9222,
    profile: 'C:\\safe profile',
    executable: 'C:\\Chrome\\chrome.exe',
    creationTime: '2026-11-16T00:00:00.000Z',
  };
  const actual = { ...expected, ownerPid: expected.pid, address: '127.0.0.1' };
  return { expected, actual };
}

test('Windows identity accepts matching process, listener and profile evidence', () => {
  const { expected, actual } = identity();
  assert.doesNotThrow(() => assertWindowsIdentity(expected, actual));
});

for (const [field, value] of [
  ['pid', 456],
  ['ownerPid', 456],
  ['port', 9333],
  ['profile', 'C:\\other profile'],
  ['executable', 'C:\\Other\\chrome.exe'],
  ['creationTime', '2026-11-16T00:00:01.000Z'],
]) {
  test(`Windows identity rejects mismatched ${field}`, () => {
    const { expected, actual } = identity();
    actual[field] = value;
    assert.throws(() => assertWindowsIdentity(expected, actual));
  });
}

for (const address of ['0.0.0.0', '192.168.1.2', '8.8.8.8', '::', '2001:db8::1']) {
  test(`Windows identity rejects non-loopback listener ${address}`, () => {
    const { expected, actual } = identity();
    actual.address = address;
    assert.throws(() => assertWindowsIdentity(expected, actual));
  });
}

for (const side of ['expected', 'actual']) {
  test(`Windows identity rejects missing ${side} creationTime`, () => {
    const pair = identity();
    delete pair[side].creationTime;
    assert.throws(() => assertWindowsIdentity(pair.expected, pair.actual));
  });
}

const currentSid = 'S-1-5-21-111-222-333-1001';
const outsiderSid = 'S-1-5-21-111-222-333-1002';
const trustedSids = [currentSid, 'S-1-5-18', 'S-1-5-32-544'];

function securitySnapshot() {
  return {
    currentSid,
    entries: [
      {
        path: 'C:\\safe profile', isDirectory: true, isReparsePoint: false,
        ownerSid: currentSid,
        rules: trustedSids.map(sid => ({ sid, allow: true, write: true })),
      },
      {
        path: 'C:\\safe profile\\state.json', isDirectory: false, isReparsePoint: false,
        ownerSid: currentSid,
        rules: trustedSids.map(sid => ({ sid, allow: true, write: true })),
      },
    ],
  };
}

test('security snapshot accepts trusted write rules and returns the snapshot', () => {
  const snapshot = securitySnapshot();
  assert.deepEqual(validateSecuritySnapshot(snapshot), snapshot);
});

for (const ownerSid of trustedSids) {
  test(`security snapshot accepts trusted owner ${ownerSid}`, () => {
    const snapshot = securitySnapshot();
    for (const entry of snapshot.entries) entry.ownerSid = ownerSid;
    assert.deepEqual(validateSecuritySnapshot(snapshot), snapshot);
  });
}

for (const index of [0, 1]) {
  const kind = index === 0 ? 'directory' : 'file';

  for (const sid of [outsiderSid, 'S-1-1-0', 'S-1-5-32-545']) {
    test(`security snapshot rejects ${kind} write access for ${sid}`, () => {
      const snapshot = securitySnapshot();
      snapshot.entries[index].rules.push({ sid, allow: true, write: true });
      assert.throws(() => validateSecuritySnapshot(snapshot));
    });
  }

  for (const [label, rule] of [
    ['read-only allow', { sid: outsiderSid, allow: true, write: false }],
    ['write deny', { sid: outsiderSid, allow: false, write: true }],
  ]) {
    test(`security snapshot accepts outsider ${label} on a ${kind}`, () => {
      const snapshot = securitySnapshot();
      snapshot.entries[index].rules.push(rule);
      assert.deepEqual(validateSecuritySnapshot(snapshot), snapshot);
    });
  }

  test(`security snapshot rejects a reparse ${kind}`, () => {
    const snapshot = securitySnapshot();
    snapshot.entries[index].isReparsePoint = true;
    assert.throws(() => validateSecuritySnapshot(snapshot));
  });

  test(`security snapshot rejects an outsider-owned ${kind}`, () => {
    const snapshot = securitySnapshot();
    snapshot.entries[index].ownerSid = outsiderSid;
    assert.throws(() => validateSecuritySnapshot(snapshot));
  });
}
