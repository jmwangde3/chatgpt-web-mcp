import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectProcessIdentity, ownProcessIdentity } from './process-identity.js';

const operationName = value => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value || '') ? value : 'operation';
export async function lockOwnerState(owner, inspect = inspectProcessIdentity) {
  if (!Number.isInteger(owner?.pid) || owner.pid < 1 || typeof owner.token !== 'string' || !owner.token) return 'UNKNOWN';
  const actual = inspect === inspectProcessIdentity && owner.pid === process.pid
    ? { status: 'ALIVE', identity: await ownProcessIdentity() }
    : await inspect(owner.pid).catch(() => ({ status: 'UNKNOWN' }));
  if (actual.status === 'DEAD') return 'DEAD';
  if (actual.status !== 'ALIVE' || !actual.identity || !owner.processStartIdentity) return 'UNKNOWN';
  return actual.identity === owner.processStartIdentity ? 'ALIVE' : 'PID_REUSED';
}

export async function readLockSnapshot(file, { inspect = inspectProcessIdentity, now = Date.now() } = {}) {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    const owner = JSON.parse(raw);
    return { exists: true, owner_state: await lockOwnerState(owner, inspect), pid: Number.isInteger(owner.pid) ? owner.pid : null,
      operation: operationName(owner.operation), started_at: Number.isFinite(owner.startedAt) ? owner.startedAt : null,
      age_ms: Number.isFinite(owner.startedAt) ? Math.max(0, now - owner.startedAt) : null,
      heartbeat_age_ms: Math.max(0, now - stat.mtimeMs), heartbeat_stale: now - stat.mtimeMs > 30000 };
  } catch (error) { return error.code === 'ENOENT' ? { exists: false } : { exists: true, owner_state: 'UNKNOWN', unreadable: true }; }
}

// Age and missed heartbeats are diagnostics, never reclamation authority.
export async function acquireLock(file, { signal, timeout = 20000, operation = 'operation', heartbeatMs = 10000, inspect = inspectProcessIdentity, processStartIdentity } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  signal?.throwIfAborted();
  const identity = processStartIdentity === undefined ? await ownProcessIdentity() : processStartIdentity;
  const deadline = Date.now() + timeout;
  const token = randomUUID();
  const readOwner = async () => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    let handle;
    try {
      handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, operation: operationName(operation), startedAt: Date.now(), processStartIdentity: identity }));
      let stopped = false, heartbeat = Promise.resolve();
      const timer = setInterval(() => {
        if (!stopped) heartbeat = heartbeat.then(() => handle.utimes(new Date(), new Date())).catch(() => {});
      }, Math.max(10, heartbeatMs));
      timer.unref?.();
      return async () => {
        if (stopped) return;
        stopped = true; clearInterval(timer); await heartbeat; await handle.close();
        const current = await readOwner();
        if (current?.token === token) await fs.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;
      const owner = await readOwner();
      const state = await lockOwnerState(owner, inspect);
      if (state === 'DEAD' || state === 'PID_REUSED') {
        let reclaim;
        const reclaimToken = randomUUID();
        try {
          reclaim = await fs.open(file + '.reclaim', 'wx', 0o600);
          await reclaim.writeFile(JSON.stringify({ pid: process.pid, token: reclaimToken }));
          const current = await readOwner();
          if (current?.token === owner.token && current.pid === owner.pid && current.processStartIdentity === owner.processStartIdentity) {
            const confirmed = await lockOwnerState(current, inspect);
            if (confirmed === 'DEAD' || confirmed === 'PID_REUSED') {
              const last = await readOwner();
              if (last?.token === current.token && last.pid === current.pid && last.processStartIdentity === current.processStartIdentity) await fs.unlink(file);
            }
          }
        } catch (e) { if (!['EEXIST', 'ENOENT'].includes(e.code)) throw e; }
        finally {
          if (reclaim) {
            await reclaim.close();
            let marker;
            try { marker = JSON.parse(await fs.readFile(file + '.reclaim', 'utf8')); } catch {}
            if (marker?.token === reclaimToken) await fs.unlink(file + '.reclaim').catch(e => { if (e.code !== 'ENOENT') throw e; });
          }
        }
      }
      await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
  }
  const error = Object.assign(new Error('Another operation owns this lock. Preserve live or unknown owners; restart its MCP process if unresponsive.'), { code: 'BUSY' });
  error.details = { lock_owner: await readLockSnapshot(file, { inspect }) };
  throw error;
}
