import test from 'node:test';
import assert from 'node:assert/strict';
import { disconnectCDPConnection } from '../src/shared/persistent-browser.js';

test('CDP disconnect closes only the local Playwright transport', async () => {
  let closeCalls = 0;
  let connected = true;
  const browser = {
    _shouldCloseConnectionOnClose: false,
    isConnected: () => connected,
    close: async () => {
      assert.equal(browser._shouldCloseConnectionOnClose, false);
      closeCalls++;
      connected = false;
    },
  };
  await disconnectCDPConnection(browser);
  assert.equal(closeCalls, 1);
  assert.equal(browser._shouldCloseConnectionOnClose, false, 'the connectOverCDP mode flag must not be mutated');
  assert.equal(connected, false);
});

test('connect() transport-close mode is rejected instead of mutating the flag', async () => {
  let closeCalls = 0;
  const browser = {
    _shouldCloseConnectionOnClose: true,
    isConnected: () => true,
    close: async () => { closeCalls++; },
  };
  await assert.rejects(disconnectCDPConnection(browser), { code: 'CDP_DISCONNECT_UNSUPPORTED' });
  assert.equal(closeCalls, 0);
  assert.equal(browser._shouldCloseConnectionOnClose, true);
});

test('unknown Playwright disconnect contract fails closed without calling close', async () => {
  let closeCalls = 0;
  const browser = {
    isConnected: () => true,
    close: async () => { closeCalls++; },
  };
  await assert.rejects(disconnectCDPConnection(browser), { code: 'CDP_DISCONNECT_UNSUPPORTED' });
  assert.equal(closeCalls, 0);
});

test('already disconnected CDP browser is a no-op', async () => {
  let closeCalls = 0;
  const browser = {
    _shouldCloseConnectionOnClose: false,
    isConnected: () => false,
    close: async () => { closeCalls++; },
  };
  await disconnectCDPConnection(browser);
  assert.equal(closeCalls, 0);
});
