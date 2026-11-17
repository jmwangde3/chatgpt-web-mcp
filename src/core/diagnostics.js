import { verifyWindowsPaths, inspectWindowsBrowserProcess } from '../shared/windows-security.js';
import { inspectLinuxBrowserProcess } from '../shared/native-browser-identity.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readState, processAlive, browserEndpoint } from '../shared/persistent-browser.js';
import { validateJournal, journalStatistics } from './tasks.js';
import { readLockSnapshot } from '../shared/locks.js';
import { Installer, installDirectory } from '../maintenance.js';

async function localState(file) {
  const state = await readState(file);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid local state');
  return state;
}

// Read-only local inspection: no locks created, no browser launch, no page access.
// Only allowlisted fields leave this module. Raw paths, URLs, replies and errors
// may contain personal information and must never appear in this report.
export async function diagnose(kernel, ids = [...kernel.providers.keys()]) {
  const providers = await Promise.all(ids.map(async (id) => {
    const adapter = kernel.provider(id);
    const config = adapter.localConfig;
    const checks = [];
    const check = (name, status, code, action) => checks.push({ name, status, code, action });
    try {
      if (!config?.executable || !(await fs.stat(config.executable)).isFile()) throw new Error();
      check('browser_executable', 'pass', 'AVAILABLE', 'none');
    } catch { check('browser_executable', 'fail', 'NO_BROWSER', 'Install Chrome/Edge or configure the provider executable.'); }
    try {
      const runtime = await localState(config.runtimeState);
      check('runtime_state', runtime.circuitBreaker?.active ? 'warn' : 'pass', runtime.circuitBreaker?.active ? 'RATE_LIMITED' : 'READABLE', runtime.circuitBreaker?.active ? 'Wait for manual provider recovery; never automatically retry.' : 'none');
      if (runtime.pending || runtime.activeGeneration?.active || Object.values(runtime.sessions || {}).some(s => s.pending || s.activeGeneration?.active)) check('provider_pending', 'warn', 'PENDING', 'Inspect existing answers before switching installed versions. New work can use an independent session_id.');
    } catch { check('runtime_state', 'fail', 'UNREADABLE_STATE', 'Inspect the local state privately; do not delete it to retry.'); }
    try {
      const browser = await localState(config.browserState);
      check('browser_process', 'info', processAlive(browser.pid) ? 'RUNNING_UNVERIFIED' : 'NOT_RUNNING', 'Local PID check only; sign-in and browser connectivity are not verified.');
    } catch { check('browser_process', 'fail', 'UNREADABLE_STATE', 'Inspect local browser state privately.'); }
    if (process.platform === 'win32' && config?.profile) {
      try { await verifyWindowsPaths(config, { allowCreate: false }); check('profile_security', 'pass', 'VERIFIED', 'none'); }
      catch (error) { check('profile_security', error.code === 'PROFILE_MISSING' ? 'warn' : 'fail', ['PROFILE_MISSING','PROFILE_REPARSE_POINT','PROFILE_IN_REPOSITORY','PROFILE_ACL_UNSAFE','PROFILE_NOT_DIRECTORY','PROFILE_NOT_FILE','SECURITY_QUERY_TIMEOUT'].includes(error.code) ? error.code : 'PROFILE_SECURITY_UNVERIFIED', 'Inspect locally; existing permissions and data were preserved.'); }
    }
    try {
      const saved = await localState(config.browserState);
      const reachable = Boolean(await browserEndpoint(saved.port));
      const inspect = process.platform === 'win32' ? inspectWindowsBrowserProcess : process.platform === 'linux' ? inspectLinuxBrowserProcess : null;
      const assessment = saved.pid && inspect && config.profile && Number.isInteger(saved.port) ? await inspect({ ...saved, executable: config.executable, profile: config.profile }) : { state: !saved.pid && !reachable ? 'NOT_RUNNING' : 'UNKNOWN' };
      const status = assessment.state === 'PROCESS_MATCHED' && reachable ? 'CDP_REACHABLE' : assessment.state === 'NOT_RUNNING' && reachable ? 'UNKNOWN' : assessment.state;
      checks.push({ name: 'browser_lifecycle', status: status === 'IDENTITY_MISMATCH' ? 'fail' : status === 'CDP_REACHABLE' ? 'pass' : 'warn', code: status,
        pid: Number.isInteger(assessment.identity?.pid || saved.pid) ? assessment.identity?.pid || saved.pid : null,
        port: Number.isInteger(saved.port) ? saved.port : null, endpoint_reachable: reachable,
        action: status === 'PROCESS_MATCHED_NO_CDP' ? 'Do not launch another Chrome. Inspect the dedicated process manually; preserve state.' : 'Read-only process and endpoint evidence; sign-in is not checked.' });
    } catch { check('browser_lifecycle', 'warn', 'UNKNOWN', 'Preserve state and inspect locally. No browser was started or terminated.'); }
    for (const [name, file] of [['operation_lock', config?.operationLock], ['task_lock', path.join(kernel.directory, id, 'tasks.json.lock')], ['runtime_lock', config?.runtimeState && config.runtimeState + '.lock']]) {
      if (!file) continue;
      try {
        const owner = await readLockSnapshot(file);
        if (!owner.exists) { check(name, 'pass', 'AVAILABLE', 'none'); continue; }
        checks.push({ name, status: 'warn', code: owner.owner_state === 'ALIVE' ? 'IN_USE' : ['DEAD','PID_REUSED'].includes(owner.owner_state) ? 'STALE_OWNER' : 'UNREADABLE_LOCK', owner,
          action: 'Snapshot only. Age is not reclamation authority. Restart an unresponsive live MCP owner; preserve unknown owners.' });
      } catch (error) {
        if (error.code === 'ENOENT') check(name, 'pass', 'AVAILABLE', 'none');
        else check(name, 'warn', 'UNREADABLE_LOCK', 'Lock may be initializing or damaged. Inspect locally before changing it.');
      }
    }
    try {
      const journal = validateJournal(await readState(path.join(kernel.directory, id, 'tasks.json')), id);
      const statistics = journalStatistics(journal);
      const counts = statistics.state_counts;
      const active = Object.values(journal.tasks).filter(t => !['completed', 'cancelled', 'failed', 'abandoned'].includes(t.state));
      checks.push({ name: 'task_journal', status: active.length ? 'warn' : 'pass', code: active.length ? 'TASK_ACTIVE' : 'READABLE', counts, ...statistics, active_state: journal.active ? journal.tasks[journal.active].state : null, action: active.length ? 'Use chat_tasks, then chat_result for existing tasks. Independent work may use a new session_id; do not resend uncertain work.' : 'none' });
    } catch { check('task_journal', 'fail', 'INVALID_JOURNAL', 'Inspect and restore the local journal privately; preserve duplicate-request records.'); }
    const controllers = [];
    for (const item of [adapter, ...[...(kernel.sessions?.values() || [])].filter(p => p.id === id)]) {
      if (item.browser.controllerDiagnostics) controllers.push(await item.browser.controllerDiagnostics());
    }
    return { provider: id, ok: !checks.some((item) => item.status === 'fail'), checks, controllers };
  }));
  const nodeOK = Number(process.versions.node.split('.')[0]) >= 20;
  let installation;
  try {
    const state = await new Installer().manifest();
    const failure = await readState(path.join(installDirectory(), 'last-failure.json'));
    installation = { managed: !!state.current, version: /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(state.package_version || '') ? state.package_version : null, rollback_available: !!state.previous,
      last_failure: ['prepare', 'download', 'dependencies', 'unit_tests', 'mcp_smoke', 'activate'].includes(failure?.stage) ? { stage: failure.stage, code: 'INSTALL_FAILED', unresolved: Number(failure.at) > Number(state.activated_at || 0) } : null };
  } catch { installation = { code: 'INVALID_INSTALL', action: 'Inspect managed installation metadata locally; do not modify browser profiles.' }; }
  return { schema_version: 1, scope: 'local_only', sign_in_verified: false, node: { version: process.version, ok: nodeOK }, ok: nodeOK && providers.every((p) => p.ok) && !installation.code, installation, providers };
}
