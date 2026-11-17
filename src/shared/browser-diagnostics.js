import fs from 'node:fs/promises';
import path from 'node:path';

const queues = new Map();
const fields = ['pid', 'exitCode', 'signal', 'durationMs', 'expected', 'errorName', 'controller_state', 'attach_age_ms', 'endpoint_reachable'];
export function safeControlDiagnostics(value = {}) {
  const out = {};
  for (const key of ['browser_state_pid', 'browser_state_port', 'attach_age_ms', 'attach_started_at', 'attach_timed_out_at']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) out[key] = value[key];
  }
  if (typeof value.endpoint_reachable === 'boolean') out.endpoint_reachable = value.endpoint_reachable;
  if (['DISCONNECTED','CONNECTING','CONNECTED','ATTACH_TIMEOUT_PENDING','DISCONNECTING','CONTROLLER_POISONED'].includes(value.controller_state)) out.controller_state = value.controller_state;
  if (typeof value.restart_mcp_required === 'boolean') out.restart_mcp_required = value.restart_mcp_required;
  for (const key of ['operation_lock_owner', 'task_lock_owner']) {
    const owner = value[key];
    if (!owner || typeof owner !== 'object') continue;
    const item = {};
    for (const name of ['exists','heartbeat_stale','unreadable']) if (typeof owner[name] === 'boolean') item[name] = owner[name];
    for (const name of ['pid','started_at','age_ms','heartbeat_age_ms']) if (Number.isFinite(owner[name]) && owner[name] >= 0) item[name] = owner[name];
    if (['ALIVE','DEAD','PID_REUSED','UNKNOWN'].includes(owner.owner_state)) item.owner_state = owner.owner_state;
    if (/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(owner.operation || '')) item.operation = owner.operation;
    out[key] = item;
  }
  return out;
}
// Deliberate allowlist: never persist page URLs, target IDs, error messages,
// browser stderr, account data or any user/page content.
export function browserDiagnostics(stateFile) {
  const file = path.join(path.dirname(stateFile), 'browser-diagnostics.jsonl');
  return (event, data = {}) => {
    const entry = { at: new Date().toISOString(), event };
    for (const key of fields) if (data[key] !== undefined) entry[key] = data[key];
    const next = (queues.get(file) || Promise.resolve()).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      if ((await fs.stat(file).catch(() => null))?.size > 512 * 1024) {
        await fs.rename(file, file + '.1').catch(() => {});
      }
      await fs.appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    }).catch(() => {});
    queues.set(file, next);
    void next.finally(() => { if (queues.get(file) === next) queues.delete(file); });
    return next;
  };
}
