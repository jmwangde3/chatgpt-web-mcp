import { verifyWindowsProcess, verifyWindowsPaths, inspectWindowsBrowserProcess } from './windows-security.js';
import { verifyLinuxBrowserProcess, inspectLinuxBrowserProcess } from './native-browser-identity.js';
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { controlRequest } from './control.js';
import { browserDiagnostics, safeControlDiagnostics } from './browser-diagnostics.js';
import { acquireLock, readLockSnapshot } from './locks.js';
import { inspectProcessIdentity } from './process-identity.js';
import { verifyDataPaths } from './data-security.js';
export { acquireLock } from './locks.js';

export class WebUIError extends Error {
  constructor(code, message) { super(message); this.name = "WebUIError"; this.code = code; }
}

export async function readState(file, missingValue = {}) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return missingValue; throw error; }
}

export async function writeState(file, value, { fsImpl = fs, delayImpl = delay } = {}) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fsImpl.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
    await handle.close();
    handle = null;
    for (let attempt = 0; ; attempt++) {
      try { await fsImpl.rename(temp, file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
        await delayImpl(10 * 2 ** attempt);
      }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsImpl.unlink(temp).catch(() => {});
  }
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function browserEndpoint(port, { signal, timeout = 1000, fetchImpl = fetch } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    signal?.throwIfAborted();
    const probeSignal = AbortSignal.timeout(timeout);
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: signal ? AbortSignal.any([signal, probeSignal]) : probeSignal });
    if (!response.ok) return null;
    const value = await response.json();
    const url = new URL(value.webSocketDebuggerUrl);
    return url.protocol === 'ws:' && url.hostname === "127.0.0.1" && Number(url.port) === port ? url.href : null;
  } catch { signal?.throwIfAborted(); return null; }
}

// Provider-neutral persistent Chrome runtime. Connecting and disconnecting does
// not terminate Chrome; only explicit terminate() sends Browser.close.
export class PersistentBrowser {
  constructor(config, { connect = chromium.connectOverCDP.bind(chromium), fetchImpl = fetch, spawnImpl = spawn, inspectPID = inspectProcessIdentity, stateIO = {}, security = process.platform === "win32" ? { paths: verifyDataPaths, process: verifyWindowsProcess, inspect: inspectWindowsBrowserProcess } : process.platform === 'linux' ? { paths: verifyDataPaths, process: verifyLinuxBrowserProcess, inspect: inspectLinuxBrowserProcess } : null } = {}) {
    this.stateIO = { read: readState, write: writeState, unlink: file => fs.unlink(file), ...stateIO };
    this.launchIntent = `${config.browserState}.launch-intent.json`;
    this.launchChild = null;
    this.pendingLaunch = null;
    this.security = security;
    this.inspectPID = inspectPID;
    this.config = config; this.browser = null; this.context = null;
    this.connector = connect; this.fetchImpl = fetchImpl; this.spawnImpl = spawnImpl;
    this.diagnostic = browserDiagnostics(config.browserState);
    this.disconnecting = null; this.attaching = null; this.launched = false;
    this.preparing = false; this.attachState = 'DISCONNECTED'; this.attachStartedAt = null; this.attachTimedOutAt = null;
  }

  async connect(signal) {
    signal = signal || undefined;
    signal?.throwIfAborted();
    if (this.browser?.isConnected()) { this.attachState = 'CONNECTED'; return this.context; }
    if (this.attaching || this.disconnecting || this.preparing) {
      const error = new WebUIError('CONTROL_BUSY', 'The original controller attempt or cleanup is pending. Restart the MCP service if it remains unresponsive; preserve Chrome and the original task.');
      error.safeDiagnostics = await this.controlDiagnostics(); throw error;
    }
    this.preparing = true; this.attachState = 'CONNECTING'; this.attachStartedAt = Date.now(); this.attachTimedOutAt = null;
    try {
      const lock = this.config.browserLaunchLock;
      if (!lock) return await this.connectOnce(signal);
      if (this.security) await this.security.paths({ protectedFiles: [lock, lock + '.reclaim'] });
      const release = await acquireLock(lock, { signal, timeout: this.config.actionTimeout, operation: 'browser-launch' });
      try { return await this.connectOnce(signal); }
      finally { await release(); }
    }
    catch (error) {
      if (this.attachState === 'CONNECTING' && !this.attaching) this.attachState = 'DISCONNECTED';
      throw error;
    } finally { this.preparing = false; }
  }

  async controlDiagnostics() {
    const saved = await readState(this.config.browserState).catch(() => ({}));
    const [operation, task] = await Promise.all([
      this.config.operationLock ? readLockSnapshot(this.config.operationLock) : null,
      this.config.taskLock ? readLockSnapshot(this.config.taskLock) : null,
    ]);
    return safeControlDiagnostics({ browser_state_pid: saved.pid, browser_state_port: saved.port,
      endpoint_reachable: this.endpointReachable, controller_state: this.attachState,
      attach_age_ms: this.attachStartedAt ? Date.now() - this.attachStartedAt : 0,
      attach_started_at: this.attachStartedAt, attach_timed_out_at: this.attachTimedOutAt,
      operation_lock_owner: operation, task_lock_owner: task,
      restart_mcp_required: ['ATTACH_TIMEOUT_PENDING','CONTROLLER_POISONED'].includes(this.attachState) });
  }

  async connectOnce(signal) {
    signal = signal || undefined;
    signal?.throwIfAborted();
    if (this.browser?.isConnected()) return this.context;
    if (this.attaching || this.disconnecting) throw new WebUIError('CONTROL_BUSY', 'The previous control connection is still closing; retry reading the same task later.');
    const config = this.config;
    this.launched = false;
    if (this.security) await this.security.paths({ ...config, protectedFiles: [...(config.protectedFiles || []), this.launchIntent] });
    const io = this.stateIO;
    let prior = await io.read(config.browserState);
    const missingIntent = Symbol('missing launch intent');
    const intent = await io.read(this.launchIntent, missingIntent);
    const recovering = intent !== missingIntent;
    if (recovering) {
      if (!intent || !Number.isInteger(intent.pid) || intent.pid < 1 || !Number.isInteger(intent.port) || intent.port < 1 || intent.port > 65535 || intent.profile !== config.profile || intent.executable !== config.executable || !intent.launchId) {
        throw new WebUIError('BROWSER_LAUNCH_UNCERTAIN', 'A launch intent cannot be safely recovered. Preserve Chrome and inspect manually; no second browser was launched.');
      }
      prior = intent;
    }
    let priorMissing = false;
    if (prior.pid && this.security?.inspect) {
      const inspection = await this.security.inspect({ ...prior, executable: config.executable, profile: config.profile });
      if (inspection.state === 'PROCESS_MATCHED_NO_CDP') throw new WebUIError('BROWSER_NO_CDP', 'The verified dedicated process has no debugging listener. Preserve it and inspect manually; no second browser was launched.');
      if (['UNKNOWN','IDENTITY_MISMATCH'].includes(inspection.state)) {
        const error = new WebUIError('BROWSER_IDENTITY_MISMATCH', 'Dedicated process identity is unknown or mismatched. No process was started or terminated.');
        error.safeDiagnostics = safeControlDiagnostics({ process_identity_reason: inspection.reason });
        throw error;
      }
      if (inspection.state === 'NOT_RUNNING') {
        if (await browserEndpoint(prior.port, { signal, fetchImpl: this.fetchImpl })) throw new WebUIError('BROWSER_IDENTITY_MISMATCH', 'The recorded PID is absent but its port is still reachable. State was preserved.');
        priorMissing = true;
      }
    }
    if (this.security && prior.pid && !priorMissing) {
      const identity = await this.security.process({ ...prior, executable: config.executable, profile: config.profile });
      if (prior.creationTime !== identity.creationTime || prior.processStartIdentity !== identity.processStartIdentity || prior.pid !== identity.pid) { prior = { ...prior, ...identity }; await io.write(config.browserState, prior); }
    }
    const probe = port => browserEndpoint(port, { signal, fetchImpl: this.fetchImpl });
    let target = prior.profile === config.profile && processAlive(prior.pid) ? await probe(prior.port) : null;
    if (recovering) {
      if (!target) throw new WebUIError('BROWSER_LAUNCH_UNCERTAIN', 'The recorded launch cannot be reached. Preserve it and inspect manually; no second browser was launched.');
      await io.write(config.browserState, prior);
      this.launchChild?.unref();
      this.launchChild = null;
      this.pendingLaunch = null;
      await io.unlink(this.launchIntent);
    }
    if (!target) {
      if (prior.pid && processAlive(prior.pid)) throw new WebUIError("BROWSER_UNREACHABLE", "The dedicated browser is running but unreachable; inspect it before restarting.");
      if (prior.pid) void this.diagnostic('saved_process_missing', { pid: prior.pid });
      if (!config.executable) throw new WebUIError("NO_BROWSER", "Install Chrome/Edge or configure the provider browser executable.");
      await fs.mkdir(config.profile, { recursive: true, mode: 0o700 });
      const port = await freePort();
      const args = [
        `--user-data-dir=${config.profile}`, "--profile-directory=Default",
        `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
        "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
        ...(config.launchArgs || []), ...(config.headless ? ["--headless=new"] : []), config.url,
      ];
      signal?.throwIfAborted();
      // Keep an independent record across the spawn/publication gap. An intent
      // without a PID is deliberately never interpreted as permission to retry.
      const launch = { launchId: randomUUID(), port, profile: config.profile, executable: config.executable, startedAt: Date.now() };
      await io.write(this.launchIntent, launch);
      signal?.throwIfAborted();
      const child = this.spawnImpl(config.executable, args, { detached: true, stdio: "ignore", windowsHide: true });
      this.launchChild = child;
      let launchError;
      child.on("error", (error) => { launchError = error; void this.diagnostic('process_error', { errorName: error.name }); });
      child.on('exit', (exitCode, exitSignal) => { void this.diagnostic('process_exit', { pid: child.pid, exitCode, signal: exitSignal }); });
      this.launched = true;
      launch.pid = child.pid;
      this.pendingLaunch = launch;
      await io.write(this.launchIntent, launch);
      if (!Number.isInteger(child.pid) || child.pid < 1) throw new WebUIError('BROWSER_LAUNCH_UNCERTAIN', 'The spawned browser has no confirmed PID. Preserve the launch intent and inspect manually.');
      await io.write(config.browserState, launch);
      child.unref();
      this.launchChild = null;
      this.pendingLaunch = null;
      await io.unlink(this.launchIntent);
      void this.diagnostic('process_started', { pid: child.pid });
      const deadline = Date.now() + config.actionTimeout;
      while (Date.now() < deadline && !(target = await probe(port))) {
        if (launchError) throw launchError;
        if (child.exitCode !== null && !(this.security && process.platform === "win32" && child.exitCode === 0)) throw new WebUIError("BROWSER_EXITED", "Browser exited; the dedicated profile may already be in use.");
        await delay(200, undefined, { signal });
      }
      if (!target) throw new WebUIError("BROWSER_TIMEOUT", "Timed out connecting to the dedicated browser.");
    }
    this.endpointReachable = Boolean(target);
    if (this.security) {
      const state = await io.read(config.browserState);
      const identity = await this.security.process({ ...state, executable: config.executable, profile: config.profile });
      if (state.creationTime !== identity.creationTime || state.processStartIdentity !== identity.processStartIdentity || state.pid !== identity.pid) await io.write(config.browserState, { ...state, ...identity });
    }
    signal?.throwIfAborted();
    const started = Date.now();
    void this.diagnostic('connect_started');
    let accepted = true;
    const attempt = Promise.resolve().then(() => this.connector(target, { timeout: config.actionTimeout }));
    this.attaching = attempt;
    // Aborted/timed-out attaches may finish late. They must never become the
    // active controller or leak into the next operation.
    void attempt.then(async browser => {
      if (!accepted) await this.disconnectController(browser).catch(() => {});
    }, () => {}).finally(() => {
      if (this.attaching === attempt) this.attaching = null;
      if (!this.disconnecting) this.attachState = this.browser?.isConnected() ? 'CONNECTED' : 'DISCONNECTED';
    });
    try {
      const browser = await controlRequest(attempt, { timeout: config.actionTimeout, signal, code: 'CONTROL_CONNECT_TIMEOUT', onInterrupt: () => { accepted = false; } });
      if (signal?.aborted) { accepted = false; await this.disconnectController(browser).catch(() => {}); signal.throwIfAborted(); }
      this.browser = browser;
      this.attachState = 'CONNECTED';
      this.context = browser.contexts()[0];
      if (!this.context) { await this.disconnect(); throw new WebUIError("NO_CONTEXT", "The browser returned no default context."); }
      this.context.setDefaultTimeout(config.actionTimeout);
      const track = page => page.on('crash', () => { void this.diagnostic('page_crashed'); });
      this.context.pages().forEach(track);
      this.context.on('page', track);
      browser.on('disconnected', () => { void this.diagnostic('controller_disconnected', { expected: this.browser !== browser }); });
      void this.diagnostic('connect_ready', { durationMs: Date.now() - started });
      return this.context;
    } catch (error) {
      accepted = false;
      if (error.code === 'CONTROL_CONNECT_TIMEOUT') {
        this.attachTimedOutAt = Date.now(); this.attachState = 'ATTACH_TIMEOUT_PENDING';
        error.safeDiagnostics = await this.controlDiagnostics();
      }
      void this.diagnostic('connect_failed', { durationMs: Date.now() - started, errorName: error.name });
      throw error;
    }
  }

  async disconnect() {
    const browser = this.browser;
    this.browser = null; this.context = null;
    if (!browser) return this.disconnecting ? controlRequest(this.disconnecting, { timeout: 5000, code: 'CONTROL_DISCONNECT_TIMEOUT' }) : undefined;
    return this.disconnectController(browser);
  }

  async lifecycle() {
    const state = await readState(this.config.browserState).catch(() => ({}));
    const reachable = Boolean(await browserEndpoint(state.port, { fetchImpl: this.fetchImpl }));
    let assessment = { state: !state.pid && !reachable ? 'NOT_RUNNING' : 'UNKNOWN' };
    if (state.pid && this.security?.inspect) assessment = await this.security.inspect({ ...state, executable: this.config.executable, profile: this.config.profile });
    else if (state.pid && !processAlive(state.pid) && !reachable) assessment = { state: 'NOT_RUNNING' };
    const status = assessment.state === 'PROCESS_MATCHED' && reachable ? 'CDP_REACHABLE'
      : assessment.state === 'NOT_RUNNING' && reachable ? 'UNKNOWN' : assessment.state;
    return { status, pid: Number.isInteger(assessment.identity?.pid || state.pid) ? assessment.identity?.pid || state.pid : null, port: Number.isInteger(state.port) ? state.port : null,
      endpoint_reachable: reachable, controller: await this.controlDiagnostics() };
  }

  async disconnectController(browser) {
    this.attachState = 'DISCONNECTING';
    const closing = Promise.resolve().then(() => browser.close());
    this.disconnecting = closing;
    void closing.then(() => { if (this.disconnecting === closing) { this.disconnecting = null; this.attachState = this.attaching ? 'ATTACH_TIMEOUT_PENDING' : 'DISCONNECTED'; } }, () => {
      // A failed close with a live controller poisons this runtime. Do not let
      // the next request overlap an unconfirmed controller cleanup.
      if (!browser.isConnected() && this.disconnecting === closing) { this.disconnecting = null; this.attachState = 'DISCONNECTED'; }
      else this.attachState = 'CONTROLLER_POISONED';
    });
    try { await controlRequest(closing, { timeout: 5000, code: 'CONTROL_DISCONNECT_TIMEOUT' }); }
    catch (error) { this.attachState = 'CONTROLLER_POISONED'; error.safeDiagnostics = await this.controlDiagnostics(); void this.diagnostic('disconnect_failed', { errorName: error.name }); throw error; }
  }

  async terminate() {
    if (this.config.preventTerminate) throw new WebUIError('SHARED_BROWSER', 'A single provider cannot terminate the shared MCP browser. Close it manually only after checking both providers.');
    // Never launch a browser just to close one.
    const initial = await readState(this.config.browserState);
    const endpoint = await browserEndpoint(initial.port, { fetchImpl: this.fetchImpl });
    if (!processAlive(initial.pid) && !endpoint) {
      if (this.security?.inspect && initial.pid) {
        const inspected = await this.security.inspect({ ...initial, executable: this.config.executable, profile: this.config.profile });
        if (inspected.state !== 'NOT_RUNNING') throw new WebUIError('BROWSER_IDENTITY_MISMATCH', 'Absence of the original browser could not be verified; state was preserved.');
      }
      return { closed: false, browserRunning: false };
    }
    await this.connect();
    const state = await readState(this.config.browserState);
    if (!this.security?.process) throw new WebUIError('BROWSER_IDENTITY_MISMATCH', 'The close target has no verified process identity; state was preserved.');
    const verified = await this.security.process({ ...state, executable: this.config.executable, profile: this.config.profile });
    const signature = value => JSON.stringify(['pid','port','creationTime','processStartIdentity','profile','executable'].map(key => value[key] ?? null));
    if (verified.pid !== state.pid || verified.port !== state.port || verified.profile !== state.profile ||
        (state.creationTime && verified.creationTime !== state.creationTime) ||
        (state.processStartIdentity && verified.processStartIdentity !== state.processStartIdentity)) throw new WebUIError('BROWSER_IDENTITY_MISMATCH', 'The reconnected close target changed identity; state was preserved.');
    const expectedStart = state.processStartIdentity || (state.creationTime && 'windows:' + state.creationTime);
    if (!expectedStart) throw new WebUIError('BROWSER_IDENTITY_MISMATCH', 'Creation identity for the close target is unavailable.');
    const session = await this.browser.newBrowserCDPSession();
    await session.send("Browser.close").catch((error) => {
      if (!/closed/i.test(error.message)) throw error;
    });
    await this.disconnect();
    const deadline = Date.now() + this.config.actionTimeout;
    let ended = false;
    while (Date.now() < deadline) {
      const [identity, reachable] = await Promise.all([this.inspectPID(state.pid), browserEndpoint(state.port, { fetchImpl: this.fetchImpl })]);
      const processGone = identity.status === 'DEAD' || (identity.status === 'ALIVE' && identity.identity && identity.identity !== expectedStart);
      if (signature(await readState(this.config.browserState)) !== signature(state)) throw new WebUIError('BROWSER_STATE_CHANGED', 'A newer browser instance replaced the close target; its state was preserved.');
      if (processGone && !reachable) { ended = true; break; }
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    if (!ended) throw new WebUIError("CLOSE_TIMEOUT", "The original process and debugging endpoint have not both been confirmed ended; state was preserved.");
    if (signature(await readState(this.config.browserState)) !== signature(state)) throw new WebUIError('BROWSER_STATE_CHANGED', 'Browser identity changed before cleanup; state was preserved.');
    await fs.unlink(this.config.browserState).catch((error) => { if (error.code !== "ENOENT") throw error; });
    return { closed: true };
  }
}
