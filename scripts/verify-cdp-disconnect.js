#!/usr/bin/env node
// Standalone real-CDP diagnostic: operates only on the Chrome child and profile
// created by this process. Never attaches to an existing browser/profile.
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_EXECUTABLE } from '../src/config.js';
import { browserEndpoint, disconnectCDPConnection } from '../src/shared/persistent-browser.js';

const HARD_DEADLINE_MS = 90000;
const startedAt = Date.now();
let phase = 'initializing';
let launched;
let profile;
let attached;
let reattached;
let hardTimer;
let interrupted = false;
const detachPromises = new WeakMap();
const report = (stage, detail = '') => {
  phase = stage;
  console.error(`[CDP verify +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${stage}${detail ? ': ' + detail : ''}`);
};
const note = (event, detail = '') => {
  console.error(`[CDP verify +${((Date.now() - startedAt) / 1000).toFixed(1)}s] event ${event}${detail ? ': ' + detail : ''}`);
};
const fail = (code, message) => Object.assign(new Error(message), { code });

function killOwnedChild() {
  // ChildProcess.kill() operates on the process handle that this script spawned.
  // Never search for or terminate an unrelated Chrome by process name or port.
  if (launched && launched.exitCode === null && launched.signalCode === null) {
    try { return launched.kill(); } catch { return false; }
  }
  return false;
}

async function limited(name, action, timeoutMs, { silent = false } = {}) {
  if (!silent) report(name, `timeout ${timeoutMs}ms`);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail('CDP_STAGE_TIMEOUT', `${name} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function detachOnce(browser) {
  let pending = detachPromises.get(browser);
  if (!pending) {
    pending = Promise.resolve().then(() => disconnectCDPConnection(browser));
    detachPromises.set(browser, pending);
  }
  return pending;
}

async function freePort() {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

async function waitForEndpoint(port, deadlineMs = 15000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (launched && (launched.exitCode !== null || launched.signalCode !== null)) {
      throw fail('CDP_CHROME_EXITED', 'The dedicated Chrome child exited before CDP was ready.');
    }
    const endpoint = await limited('probe-endpoint', () => browserEndpoint(port), 3000, { silent: true });
    if (endpoint) return endpoint;
    await delay(150);
  }
  throw fail('CDP_ENDPOINT_TIMEOUT', 'Dedicated Chrome did not expose its local CDP endpoint within 15 seconds.');
}

async function cleanupOwnedBrowser() {
  // Never call Browser.close() unless the pinned Playwright disconnect contract
  // is recognized; if detach fails, terminate only the child launched here.
  for (const browser of [reattached, attached]) {
    if (browser && typeof browser.isConnected === 'function' && browser.isConnected()) {
      if (detachPromises.has(browser)) {
        console.error('[CDP verify cleanup] A detach attempt is already pending; not issuing a duplicate Browser.close.');
        continue;
      }
      try { await limited('cleanup-local-CDP-transport', () => detachOnce(browser), 4000); }
      catch (error) { console.error(`[CDP verify cleanup] Detach incomplete: ${error.code || error.message}`); }
    }
  }

  let stopped = !launched || launched.exitCode !== null || launched.signalCode !== null;
  if (!stopped && launched) {
    report('stopping-owned-Chrome', `pid ${launched.pid}`);
    const exited = new Promise(resolve => {
      launched.once('exit', () => resolve(true));
    });
    killOwnedChild();
    stopped = await Promise.race([exited, delay(4000).then(() => false)]);
  }
  if (!profile) return;
  if (!stopped) {
    console.error('[CDP verify cleanup] Child exit unconfirmed; temporary profile preserved: ' + profile);
    return;
  }
  try {
    await limited('remove-temporary-profile', () => fs.rm(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }), 6000);
  } catch (error) {
    console.error('[CDP verify cleanup] Temporary profile not fully removed: ' + error.message);
  }
}

function stopOnSignal(signal) {
  if (interrupted) return;
  interrupted = true;
  console.error(`[CDP verify] ${signal} received during ${phase}; ending this verification.`);
  killOwnedChild();
  // This is a standalone verifier. Force-exit if a pending CDP operation does
  // not respond to browser termination. No other Chrome process is touched.
  setTimeout(() => process.exit(130), 1500).unref();
}
process.once('SIGINT', () => stopOnSignal('SIGINT'));
process.once('SIGTERM', () => stopOnSignal('SIGTERM'));

async function main() {
  if (!CHROME_EXECUTABLE) throw fail('CHROME_NOT_FOUND', 'Set CHATGPT_WEB_CHROME or install Chrome/Edge.');
  const port = await limited('reserve-loopback-port', freePort, 4000);
  profile = await limited('create-isolated-profile', () => fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-web-cdp-detach-')), 5000);
  report('spawn-isolated-Chrome', `port ${port}; profile ${profile}`);
  launched = spawn(CHROME_EXECUTABLE, [
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + port,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
    '--headless=new',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  await limited('wait-for-Chrome-spawn', () => new Promise((resolve, reject) => {
    if (launched.pid && launched.spawnfile) return resolve();
    launched.once('spawn', resolve);
    launched.once('error', reject);
  }), 5000);
  report('Chrome-started', `pid ${launched.pid}; port ${port}`);
  const endpoint = await waitForEndpoint(port);
  assert.ok(endpoint, 'Dedicated Chrome CDP endpoint must become ready');
  report('CDP-endpoint-ready', `port ${port}`);

  const url = `http://127.0.0.1:${port}`;
  attached = await limited('playwright-connect-over-CDP', () => chromium.connectOverCDP(url, { timeout: 12000 }), 16000);
  const context = attached.contexts()[0];
  assert.ok(context, 'CDP must expose the default browser context');
  attached.once('disconnected', () => note('playwright-browser-disconnected'));
  report('playwright-attached', `initial pages ${context.pages().length}`);

  const page = await limited('obtain-test-page', async () => context.pages()[0] || await context.newPage(), 12000);
  page.setDefaultTimeout(7000);
  await limited('write-page-marker', () => page.setContent('<!doctype html><title>WFA_CDP_DETACH_OK</title><body>persistent marker</body>', { timeout: 7000 }), 9000);
  const title = await limited('verify-page-marker', () => page.title(), 8000);
  assert.equal(title, 'WFA_CDP_DETACH_OK');
  report('test-marker-created', title);

  await limited('detach-first-local-transport', () => detachOnce(attached), 8000);
  attached = null;
  const endpointAfterDetach = await limited('verify-Chrome-survived-detach', () => browserEndpoint(port), 4000);
  assert.ok(endpointAfterDetach, 'Dedicated Chrome CDP endpoint was lost after the local detach');
  report('Chrome-survived-detach');

  reattached = await limited('playwright-reconnect-over-CDP', () => chromium.connectOverCDP(url, { timeout: 12000 }), 16000);
  const secondContext = reattached.contexts()[0];
  assert.ok(secondContext, 'CDP reconnect must expose the browser context');
  const pages = secondContext.pages();
  reattached.once('disconnected', () => note('playwright-browser-disconnected-after-reconnect'));
  report('playwright-reconnected', `pages ${pages.length}`);
  const titles = await limited('read-surviving-page-titles', () => Promise.all(pages.map(p => p.title().catch(() => ''))), 10000);
  assert.ok(titles.includes('WFA_CDP_DETACH_OK'), 'Original tab did not survive local CDP disconnect/reconnect');
  await limited('detach-second-local-transport', () => detachOnce(reattached), 8000);
  reattached = null;
  return { ok: true, port, surviving_tabs: pages.length, marker: 'WFA_CDP_DETACH_OK' };
}

hardTimer = setTimeout(() => {
  console.error(JSON.stringify({ ok: false, code: 'CDP_HARD_DEADLINE', phase, elapsed_ms: Date.now() - startedAt }, null, 2));
  killOwnedChild();
  process.exit(124);
}, HARD_DEADLINE_MS);

let result;
try {
  result = await main();
} catch (error) {
  result = { ok: false, code: error.code || 'CDP_VERIFY_FAILED', phase, error: error.message };
} finally {
  try { await limited('cleanup-owned-resources', cleanupOwnedBrowser, 15000); }
  catch (error) {
    console.error('[CDP verify cleanup] Cleanup could not complete: ' + error.message);
  }
  clearTimeout(hardTimer);
}
console.log(JSON.stringify({ ...result, elapsed_ms: Date.now() - startedAt }, null, 2));
process.exitCode = result.ok ? 0 : 1;
// A timed-out Playwright request may retain handles after owned Chrome is
// stopped. Cap shutdown rather than leaving the verification command hanging.
setTimeout(() => process.exit(process.exitCode), 1000).unref();
