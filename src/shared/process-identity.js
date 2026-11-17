import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsQuery } from './windows-security.js';

const exec = promisify(execFile);
const self = new Map();
export async function inspectProcessIdentity(pid, { platform = process.platform, read = fs.readFile, query = windowsQuery, execute = exec, alive = p => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'ESRCH' ? false : null; } } } = {}) {
  if (!Number.isInteger(pid) || pid < 1) return { status: 'UNKNOWN', identity: null };
  if (alive(pid) === false) return { status: 'DEAD', identity: null };
  try {
    let identity;
    if (platform === 'win32') {
      const value = await query('$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$q.pid); if($p){@{creationTime=$p.CreationDate.ToUniversalTime().ToString("o")}|ConvertTo-Json -Compress}else{@{missing=$true}|ConvertTo-Json -Compress}', { pid });
      if (value.missing && alive(pid) === false) return { status: 'DEAD', identity: null };
      if (typeof value.creationTime !== 'string' || !Number.isFinite(Date.parse(value.creationTime))) throw Error('Unverified process');
      identity = 'windows:' + value.creationTime;
    } else if (platform === 'linux') {
      const [stat, boot] = await Promise.all([read(`/proc/${pid}/stat`, 'utf8'), read('/proc/sys/kernel/random/boot_id', 'utf8')]);
      const end = stat.lastIndexOf(')');
      if (end < 0 || !/^\d+ \(/.test(stat) || !/^\s/.test(stat.slice(end + 1))) throw Error('Unverified process');
      const fields = stat.slice(end + 1).trim().split(/\s+/);
      if (!/^[A-Za-z]$/.test(fields[0])) throw Error('Unverified process');
      if (fields[0] === 'Z' || fields[0] === 'X') return { status: 'DEAD', identity: null };
      const start = fields[19];
      if (!/^\d+$/.test(start || '') || !/^[a-f0-9-]+$/i.test(boot.trim())) throw Error('Unverified process');
      identity = `linux:${boot.trim()}:${start}`;
    } else if (platform === 'darwin') {
      const result = await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 3000, env: { ...process.env, LC_ALL: 'C' } });
      const start = result.stdout.trim();
      if (!Number.isFinite(Date.parse(start))) throw Error('Unverified process');
      identity = 'macos:' + start;
    } else return { status: 'UNKNOWN', identity: null };
    return { status: 'ALIVE', identity };
  } catch { return { status: alive(pid) === false ? 'DEAD' : 'UNKNOWN', identity: null }; }
}

export async function ownProcessIdentity() {
  const key = `${process.platform}:${process.pid}`;
  if (!self.has(key)) self.set(key, inspectProcessIdentity(process.pid));
  return (await self.get(key)).identity;
}
