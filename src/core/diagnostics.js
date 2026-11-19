import { inspectWindowsBrowserProcess } from '../shared/windows-security.js';
import { verifyDataPaths } from '../shared/data-security.js';
import { inspectLinuxBrowserProcess } from '../shared/native-browser-identity.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readState, processAlive, browserEndpoint } from '../shared/persistent-browser.js';
import { validateJournal, journalStatistics } from './tasks.js';
import { acquireLock, readLockSnapshot } from '../shared/locks.js';
import { Installer, installDirectory } from '../maintenance.js';

async function localState(file) {
  const state = await readState(file);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid local state');
  return state;
}

/**
 * Explicit maintenance action. Reclaim only lock files whose recorded owner
 * is independently proven DEAD or PID_REUSED. Live/unknown owners are preserved.
 * Task journals and uncertain tasks are never modified or archived here.
 */
export async function repairStaleLocks(kernel, ids = [...kernel.providers.keys()], {
  timeoutMs = 1500, acquire = acquireLock, verifyPaths = verifyDataPaths, inspect = undefined,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) {
    throw Object.assign(new Error('timeoutMs must be 100..10000.'), { code: 'INVALID_TIMEOUT' });
  }
  const locks = [];
  for (const id of ids) {
    const adapter = kernel.provider(id);
    const config = adapter.localConfig || {};
    const taskFile = path.join(kernel.directory, id, 'tasks.json');
    const candidates = [
      ['operation_lock', config.operationLock],
      ['task_lock', taskFile + '.lock'],
      ['runtime_lock', config.runtimeState ? config.runtimeState + '.lock' : null],
    ].filter(([, file]) => typeof file === 'string' && file.length > 0);
    for (const [name, file] of candidates) {
      const before = await readLockSnapshot(file, inspect ? { inspect } : undefined);
      if (!before.exists) {
        locks.push({ provider: id, lock: name, status: 'absent' });
        continue;
      }
      if (!['DEAD', 'PID_REUSED'].includes(before.owner_state)) {
        locks.push({ provider: id, lock: name, status: 'preserved', owner_state: before.owner_state });
        continue;
      }
      try {
        if (name === 'task_lock') {
          await verifyPaths({ dataDirectories: [path.dirname(taskFile)], taskJournal: taskFile, protectedFiles: [file, file + '.reclaim'] }, { allowCreate: false });
        } else {
          if (!config.profile) throw Object.assign(new Error('Profile security boundary is unavailable.'), { code: 'PROFILE_SECURITY_UNVERIFIED' });
          await verifyPaths({ ...config, protectedFiles: [...(config.protectedFiles || []), file, file + '.reclaim'] }, { allowCreate: false });
        }
        const release = await acquire(file, { timeout: timeoutMs, operation: 'doctor-repair', ...(inspect ? { inspect } : {}) });
        await release();
        const after = await readLockSnapshot(file, inspect ? { inspect } : undefined);
        locks.push({ provider: id, lock: name, status: after.exists ? 'reclaimed_or_reacquired' : 'reclaimed',
          previous_owner_state: before.owner_state });
      } catch (error) {
        locks.push({ provider: id, lock: name, status: error.code === 'BUSY' ? 'busy' : 'failed',
          code: ['BUSY', 'PROFILE_ACL_UNSAFE', 'PROFILE_MISSING', 'PROFILE_SECURITY_UNVERIFIED', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'REPAIR_FAILED' });
      }
    }
  }
  const ok = locks.every(item => !['failed', 'busy'].includes(item.status));
  return { scope: 'local_only', ok, locks, task_journal_modified: false, uncertain_tasks_modified: false };
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
    if (['win32', 'linux', 'darwin'].includes(process.platform) && config?.profile) {
      try { await verifyDataPaths(config, { allowCreate: false }); check('profile_security', 'pass', 'VERIFIED', 'none'); }
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
          action: ['DEAD','PID_REUSED'].includes(owner.owner_state)
            ? 'Run node src/cli.js doctor --repair to reclaim only verified dead-owner locks. This does not archive or alter uncertain tasks.'
            : 'Snapshot only. Age is not reclamation authority. Preserve live/unknown owners; do not delete lock files manually.' });
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
      checks.push({ name: 'task_journal', status: active.length ? 'warn' : 'pass', code: active.length ? 'TASK_ACTIVE' : 'READABLE', counts, ...statistics, active_state: journal.active ? journal.tasks[journal.active].state : null, action: active.length ? 'Use node src/cli.js tasks --provider ' + id + ' to inspect. Resume confirmed tasks by task_id. Uncertain tasks are never bulk-archived; use abandon --confirm only after exact baseline verification.' : 'none' });
    } catch { check('task_journal', 'fail', 'INVALID_JOURNAL', 'Inspect and restore the local journal privately; preserve duplicate-request records.'); }
    if (kernel.verifyStorage) {
      const file = path.join(kernel.directory, id, 'tasks.json');
      try {
        if (await fs.lstat(path.dirname(file)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
          await kernel.verifyStorage(file, false);
          check('task_storage_security', 'pass', 'VERIFIED', 'none');
        } else check('task_storage_security', 'warn', 'NOT_INITIALIZED', 'No task storage exists yet.');
      } catch { check('task_storage_security', 'fail', 'TASK_STORAGE_UNSAFE', 'Inspect task directory and file permissions locally; preserve existing data.'); }
    }
    const controllers = [];
    for (const item of [adapter, ...[...(kernel.sessions?.values() || [])].filter(p => p.id === id)]) {
      if (item.browser?.controllerDiagnostics) controllers.push(await item.browser.controllerDiagnostics());
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
