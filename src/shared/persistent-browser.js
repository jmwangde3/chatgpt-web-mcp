import { verifyWindowsProcess, verifyWindowsPaths } from './windows-security.js';
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
export { acquireLock } from './locks.js';

export class WebUIError extends Error {
  constructor(code, message) { super(message); this.name = "WebUIError"; this.code = code; }
}

export async function readState(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

export async function writeState(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
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
  constructor(config, { connect = chromium.connectOverCDP.bind(chromium), fetchImpl = fetch, spawnImpl = spawn, security = process.platform === "win32" ? { paths: verifyWindowsPaths, process: verifyWindowsProcess } : null } = {}) {
    this.security = security;
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
    try { return await this.connectOnce(signal); }
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
    if (this.security) await this.security.paths(config);
    let prior = await readState(config.browserState);
    if (this.security && prior.pid) {
      const identity = await this.security.process({ ...prior, executable: config.executable, profile: config.profile });
      if (prior.creationTime !== identity.creationTime || prior.processStartIdentity !== identity.processStartIdentity || prior.pid !== identity.pid) { prior = { ...prior, ...identity }; await writeState(config.browserState, prior); }
    }
    const probe = port => browserEndpoint(port, { signal, fetchImpl: this.fetchImpl });
    let target = prior.profile === config.profile && processAlive(prior.pid) ? await probe(prior.port) : null;
    if (!target) {
      if (prior.pid && processAlive(prior.pid)) throw new WebUIError("BROWSER_UNREACHABLE", "The dedicated browser is running but unreachable; inspect it before restarting.");
      if (prior.pid) void this.diagnostic('saved_process_missing', { pid: prior.pid });
      if (!config.executable) throw new WebUIError("NO_BROWSER", "Install Chrome/Edge or configure the provider browser executable.");
      await fs.mkdir(config.profile, { recursive: true });
      const port = await freePort();
      const args = [
        `--user-data-dir=${config.profile}`, "--profile-directory=Default",
        `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
        "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
        ...(config.launchArgs || []), ...(config.headless ? ["--headless=new"] : []), config.url,
      ];
      signal?.throwIfAborted();
      const child = this.spawnImpl(config.executable, args, { detached: true, stdio: "ignore", windowsHide: true });
      let launchError;
      child.on("error", (error) => { launchError = error; void this.diagnostic('process_error', { errorName: error.name }); });
      child.on('exit', (exitCode, exitSignal) => { void this.diagnostic('process_exit', { pid: child.pid, exitCode, signal: exitSignal }); });
      child.unref();
      this.launched = true;
      await writeState(config.browserState, { pid: child.pid, port, profile: config.profile, startedAt: Date.now() });
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
      const state = await readState(config.browserState);
      const identity = await this.security.process({ ...state, executable: config.executable, profile: config.profile });
      if (state.creationTime !== identity.creationTime || state.processStartIdentity !== identity.processStartIdentity || state.pid !== identity.pid) await writeState(config.browserState, { ...state, ...identity });
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
    return { status, pid: Number.isInteger(state.pid) ? state.pid : null, port: Number.isInteger(state.port) ? state.port : null,
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
    // Never launch a browser just to close one.
    const state = await readState(this.config.browserState);
    if (!processAlive(state.pid)) return { closed: false, browserRunning: false };
    await this.connect();
    const session = await this.browser.newBrowserCDPSession();
    await session.send("Browser.close").catch((error) => {
      if (!/closed/i.test(error.message)) throw error;
    });
    await this.disconnect();
    const deadline = Date.now() + this.config.actionTimeout;
    while (processAlive(state.pid) && Date.now() < deadline) await delay(100);
    if (processAlive(state.pid)) throw new WebUIError("CLOSE_TIMEOUT", "Browser did not exit after the close request; its state was preserved.");
    await fs.unlink(this.config.browserState).catch((error) => { if (error.code !== "ENOENT") throw error; });
    return { closed: true };
  }
}
